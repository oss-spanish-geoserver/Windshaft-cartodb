'use strict';

var testHelper = require('../../support/test_helper');

var assert = require('../../support/assert');
var fs = require('fs');
var PortedServerOptions = require('./support/ported_server_options');
var http = require('http');
var testClient = require('./support/test_client');
var nock = require('nock');

describe('external resources', function() {

    var res_serv; // resources server
    var res_serv_status = { numrequests:0 }; // status of resources server
    var res_serv_port;

    var IMAGE_EQUALS_TOLERANCE_PER_MIL = 25;

    before(function(done) {
        // Start a server to test external resources
        res_serv = http.createServer( function(request, response) {
            ++res_serv_status.numrequests;
            var filename = __dirname + '/../../fixtures/markers' + request.url;
            fs.readFile(filename, "binary", function(err, file) {
              if ( err ) {
                response.writeHead(404, {'Content-Type': 'text/plain'});
                response.write("404 Not Found\n");
              } else {
                response.writeHead(200);
                response.write(file, "binary");
              }
              response.end();
            });
        });

        const host = '127.0.0.1';
        const markersServer = res_serv.listen(0);

        res_serv_port = markersServer.address().port;

        nock.disableNetConnect();
        nock.enableNetConnect(host);

        markersServer.on('listening', done);
    });

    after(function(done) {
        testHelper.rmdirRecursiveSync(global.environment.millstone.cache_basedir);

        nock.cleanAll();
        nock.enableNetConnect();

        // Close the resources server
        res_serv.close(done);
    });

    function imageCompareFn(fixture, done) {
        return function(err, res) {
            if (err) {
                return done(err);
            }
            var referenceImagePath = './test/fixtures/' + fixture;
            assert.imageBufferIsSimilarToFile(res.body, referenceImagePath, IMAGE_EQUALS_TOLERANCE_PER_MIL, done);
        };
    }

    it("basic external resource", function(done) {

        var circleStyle = "#test_table_3 { marker-file: url('http://127.0.0.1:" + res_serv_port +
            "/circle.svg'); marker-transform:'scale(0.2)'; }";

        testClient.getTile(testClient.defaultTableMapConfig('test_table_3', circleStyle), 13, 4011, 3088,
            imageCompareFn('test_table_13_4011_3088_svg1.png', done));
    });

    it("different external resource", function(done) {

        var squareStyle = "#test_table_3 { marker-file: url('http://127.0.0.1:" + res_serv_port +
            "/square.svg'); marker-transform:'scale(0.2)'; }";

        testClient.getTile(testClient.defaultTableMapConfig('test_table_3', squareStyle), 13, 4011, 3088,
            imageCompareFn('test_table_13_4011_3088_svg2.png', done));
    });

    // See http://github.com/CartoDB/Windshaft/issues/107
    it("external resources get localized on renderer creation if not locally cached", function(done) {

        var options = {
            serverOptions: PortedServerOptions
        };

        var externalResourceStyle = "#test_table_3{marker-file: url('http://127.0.0.1:" + res_serv_port +
          "/square.svg'); marker-transform:'scale(0.2)'; }";

        var externalResourceMapConfig = testClient.defaultTableMapConfig('test_table_3', externalResourceStyle);

        testClient.createLayergroup(externalResourceMapConfig, options, function() {
            var externalResourceRequestsCount = res_serv_status.numrequests;

            testClient.createLayergroup(externalResourceMapConfig, options, function() {
                assert.equal(res_serv_status.numrequests, externalResourceRequestsCount);

                // reset resources cache
                testHelper.rmdirRecursiveSync(global.environment.millstone.cache_basedir);

                externalResourceMapConfig = testClient.defaultTableMapConfig('test_table_3 ', externalResourceStyle);

                testClient.createLayergroup(externalResourceMapConfig, options, function() {
                    assert.equal(res_serv_status.numrequests, externalResourceRequestsCount + 1);

                    done();
                });
            });
        });
    });

    it("referencing unexistant external resources returns an error", function(done) {
        var url = "http://127.0.0.1:" + res_serv_port + "/notfound.png";
        var style = "#test_table_3{marker-file: url('" + url + "'); marker-transform:'scale(0.2)'; }";

        var mapConfig = testClient.defaultTableMapConfig('test_table_3', style);

        testClient.createLayergroup(mapConfig, { statusCode: 400 }, function(err, res) {
            assert.deepEqual(JSON.parse(res.body).errors, [
                "Unable to download '" + url + "' for 'style0' (server returned 404)"]
            );
            done();
        });
    });

});
