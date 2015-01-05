'use strict';

var express = require('express'),
    app = express(),
    Controllers = require('./lib/controllers'),
    controllers = new Controllers('/tmp/dummys3_root'),
    morgan = require('morgan'),
    multipart = require('connect-multiparty'),
    multipartMiddleware = multipart();

/**
 * Log all requests
 */
app.use(morgan('combined'));

/**
 * Routes for the application
 */
app.get('/', controllers.getAllBuckets);
app.get('/:bucket', controllers.getBucket);
app.delete('/:bucket', controllers.deleteBucket);
app.put('/:bucket', controllers.putBucket);
app.put('/:bucket/:key(*)', multipartMiddleware, controllers.putKeyForBucket);
app.get('/:bucket/:key(*)', controllers.getKeyForBucket);
app.head('/:bucket/:key(*)', controllers.getKeyForBucket);

/**
 * Start the server
 */
var server = app.listen(3000, function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log('Example app listening at http://%s:%s', host, port);
});
