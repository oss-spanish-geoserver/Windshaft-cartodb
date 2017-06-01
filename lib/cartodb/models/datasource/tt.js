var debug = require('debug')('windshaft:datasources');
var dot = require('dot');
dot.templateSettings.strip = false;

var SphericalMercator = require('sphericalmercator');

var Datasource = require('./base');

var queryTemplate = dot.template([
    'SELECT * FROM TT_TileData(',
    '  \'{{=it.table}}\',',
    '  \'@bbox\'::json,',
    '  ARRAY[{{=it.filters}}]::json[],',
    '  ARRAY[{{=it.aggregations}}]::json[],',
    '  @zoom',
    ') AS tiledata (',
    '  cartodb_id int,',
    '  the_geom_webmercator geometry{{? it.aggregationsColumns.length > 0 }},{{?}}',
    '  {{=it.aggregationsColumns}}',
    ')'
].join('\n'));

// Example of the query we want to generate:
// SELECT * FROM TT_TileData(
//   'tttable',
//   '{"minx": -20037508.3, "minx": 20037508.29613578, "maxx": -20037508.29613578, "maxy": 20037508.3,3857 }',
//   ARRAY['{"type":"category", "column":"value3", "accept":["xx"]}']::json[],
//   ARRAY['{"aggregate_function":"sum", "aggregate_column":"value1", "type":"numeric"}',
//         '{"aggregate_function":"avg", "aggregate_column":"value2", "type":"numeric"}' ]::json[],
//   10 -- zoom
// ) AS tiledata(
//   cartodb_id int,
//   the_geom_webmercator geometry,
//   value1 numeric,
//   value2 numeric
// );

function TTDatasource(psql, datasource, dataviews, requestFilters) {
    Datasource.apply(this);

    this.psql = psql;
    this.datasource = datasource;
    this.dataviews = dataviews;
    this.requestFilters = requestFilters;

    this.metadata = getMetadata(this.datasource, this.getTTName(), this.dataviews, this.requestFilters);
}
TTDatasource.prototype = new Datasource();
TTDatasource.prototype.constructor = TTDatasource;

module.exports = TTDatasource;

var TYPE = 'tt';

var TT_NAME_REGEX = /tt_(.*)$/i;
TTDatasource.shouldAdapt = function(query) {
    var matches = query && query.match(TT_NAME_REGEX);
    return !!matches;
};

TTDatasource.prototype.getTTName = function() {
    var query = this.datasource.getQuery(false);
    var matches = query && query.match(TT_NAME_REGEX);
    return matches && matches[1];
};

var DATAVIEW_TYPE_2_FILTER_TYPE = {
    aggregation: 'category',
    histogram: 'range'
};

function pgJson(obj) {
    return '\'' + JSON.stringify(obj) + '\'';
}

function filterParams(filter) {
    return Object.keys(filter).reduce(function(f, k) {
        if (k !== 'dataview') {
            f[k] = filter[k];
        }
        return f;
    }, {});
}

TTDatasource.prototype.id = function() {
    return this.datasource.id();
};

TTDatasource.prototype.getDataviewQuery = function(filters) {
    return this.datasource.getQuery(filters);
};

TTDatasource.prototype.getQuery = function(filters) {
    var metadata = this.getMetadata();
    if (!metadata.hasOwnProperty('table')) {
        return this.datasource.getQuery(filters);
    }
    return queryTemplate({
        table: metadata.table,
        filters: metadata.filters.map(filterParams).map(pgJson).join(','),
        aggregations: metadata.aggregations.map(pgJson).join(','),
        aggregationsColumns: metadata.aggregations.map(function(agg) {
            var columnName = agg.aggregate_function === 'count' ?
                'count_vals' : (agg.aggregate_function + '_' + agg.aggregate_column);
            return  columnName + ' numeric';
        })
    });
};

TTDatasource.prototype.getAffectedTables = function() {
    return [];
};

TTDatasource.prototype.getFilters = function() {
    return {};
};

TTDatasource.prototype.getType = function() {
    return TYPE;
};

TTDatasource.prototype.getMetadata = function() {
    return this.metadata;
};

function getMetadata(datasource, ttName, dataviews, requestFilters) {
    var metadata = {
        type: TYPE,
        table: ttName,
        filters: [],
        aggregations: []
    };

    if (ttName) {
        debug('n', ttName);
        debug('s', datasource.id());
        debug('d', dataviews);
        debug('f', requestFilters);

        var relatedDataviewKeys = Object.keys(dataviews).filter(function(dataviewKey) {
            return dataviews[dataviewKey].source.id === datasource.id();
        });
        var filters = relatedDataviewKeys.reduce(function(filters, relatedDataviewKey) {
            if (requestFilters.dataviews.hasOwnProperty(relatedDataviewKey)) {
                var dataview = dataviews[relatedDataviewKey];
                var filter = requestFilters.dataviews[relatedDataviewKey];
                var relatedFilter = JSON.parse(JSON.stringify(filter));
                relatedFilter.dataview = relatedDataviewKey;
                relatedFilter.type = DATAVIEW_TYPE_2_FILTER_TYPE[dataview.type];
                relatedFilter.column = dataview.options.column;
                filters.push(relatedFilter);
            }
            return filters;
        }, []);

        metadata.table = ttName;
        metadata.filters = filters;
        // let's return the basic aggregation
        metadata.aggregations = [
            {
                type: 'numeric',
                aggregate_function: 'count',
                aggregate_column: '1'
            }
        ];
    }

    return metadata;
}

// -------------------------- turbo-carto interface --------------------------

TTDatasource.prototype.getName = function() {
    return 'TTDatasource';
};

TTDatasource.prototype.getRamp = function(column, buckets, method, callback) {
    this.datasource.getRamp(column, buckets, method, function() {
        this.addAggregation('avg', column);
        return callback.apply(null, arguments);
    }.bind(this));
};

TTDatasource.prototype.addAggregation = function(fn, column) {
    var exists = this.metadata.aggregations.some(function(aggregation) {
        return aggregation.aggregate_function === fn && aggregation.aggregate_column === column;
    });
    if (!exists) {
        this.metadata.aggregations.push({
            type: 'numeric',
            aggregate_function: fn,
            aggregate_column: column
        });
    }
};

// --------------------------- Dataviews interface ---------------------------

var histogramQueryTemplate = dot.template([
    'SELECT * FROM TT_Histogram(',
    '  \'{{=it.table}}\',',
    '  {{? it.bbox !== null }}\'[{{=it.bbox}}]\'{{??}}NULL{{?}}::json,',
    '  ARRAY[{{=it.filters}}]::json[],',
    '  \'{{=it.parameters}}\'::json,',
    '  0',
    ') as dataview'
].join('\n'));

var aggQueryTemplate = dot.template([
    'SELECT * FROM TT_Aggregation(',
    '  \'{{=it.table}}\',',
    '  {{? it.bbox !== null }}\'[{{=it.bbox}}]\'{{??}}NULL{{?}}::json,',
    '  ARRAY[{{=it.filters}}]::json[],',
    '  \'{{=it.parameters}}\'::json,',
    '  0',
    ') as dataview'
].join('\n'));

function pgJson(obj) {
    return '\'' + JSON.stringify(obj) + '\'';
}

function filterParams(filter) {
    return Object.keys(filter).reduce(function(f, k) {
        if (k !== 'dataview') {
            f[k] = filter[k];
        }
        return f;
    }, {});
}

TTDatasource.getDataviewQuery = function(layer, dataview, dataviewName, bboxFilter, overrideParams, ownFilter) {
    var mercator = new SphericalMercator({ size: 256 });
    var ttMetadata = layer.options.meta;
    var bbox = (bboxFilter === null) ? null : mercator.convert(bboxFilter.bboxes[0], '900913').join(',');

    var dataviewQuery = null;
    function dataviewNameFilter(filter) {
        return (ownFilter) ? true : filter.dataview !== dataviewName;
    }

    if (isTTHistogram(layer, dataview)) {
        dataviewQuery = histogramQueryTemplate({
            table: ttMetadata.table,
            bbox: bbox,
            filters: ttMetadata.filters.filter(dataviewNameFilter).map(filterParams).map(pgJson).join(','),
            parameters: JSON.stringify({
                column: dataview.column,
                bins: overrideParams.bins,
                start: overrideParams.start,
                end: overrideParams.end
            })
        });
    }
    if (isTTAggregation(layer, dataview)) {
        dataviewQuery = aggQueryTemplate({
            table: ttMetadata.table,
            bbox: bbox,
            filters: ttMetadata.filters.filter(dataviewNameFilter).map(filterParams).map(pgJson).join(','),
            parameters: JSON.stringify({
                column: dataview.column,
                aggregation: dataview.aggregation,
                aggregationColumn: (dataview.aggregation === 'count' ? undefined : dataview.aggregationColumn)
            })
        });
    }

    return dataviewQuery;
};

function isTTHistogram(layer, dataview) {
    return layer && layer.options.meta && layer.options.meta.type === TYPE && dataview.getType() === 'histogram';
}

function isTTAggregation(layer, dataview) {
    return layer && layer.options.meta && layer.options.meta.type === TYPE && dataview.getType() === 'aggregation';
}