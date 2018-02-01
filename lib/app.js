'use strict';

var express = require('express');
var Controllers = require('./controllers');
var createLogger = require('./logger');
var path = require('path');
var https = require('https');
var morgan = require('morgan');
var subject = require('rxjs/Subject').Subject;

require('rxjs/add/operator/filter');

module.exports = function (options) {
  var app = express();
  app.s3Event = new subject();

  var logger = createLogger(options.silent);
  var controllers = new Controllers(options.directory, logger, options.indexDocument, options.errorDocument);

  /**
   * Log all requests
   */
  app.use(morgan('tiny', {
    'stream': {
      write: function (message) {
        logger.info(message.slice(0, -1));
      }
    }
  }));

  app.use(function (req, res, next) {
    var host = req.headers.host.split(':')[0];

    // Handle requests for <bucket>.s3(-<region>?).amazonaws.com, if they arrive.
    var bucket = (/(.+)\.s3(-.+)?\.amazonaws\.com$/.exec(host) || [])[1];
    if (bucket) {
      req.url = path.join('/', bucket, req.url);
    } else if (options.indexDocument && host !== 'localhost' && host !== '127.0.0.1') {
      req.url = path.join('/', host, req.url);
    }

    if (options.cors) {
      if (req.method === 'OPTIONS') {
        if (req.headers['access-control-request-headers'])
          res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
        if (req.headers['access-control-request-method'])
          res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
      }
      if (req.headers.origin)
        res.header('Access-Control-Allow-Origin', '*');
    }

    next();
  });

  app.disable('x-powered-by');

  /**
   * Routes for the application
   */
  app.get('/', controllers.getBuckets);
  app.get('/:bucket', controllers.bucketExists, controllers.getBucket);
  app.delete('/:bucket', controllers.bucketExists, controllers.deleteBucket);
  app.put('/:bucket', controllers.putBucket);
  app.put('/:bucket/:key(*)', controllers.bucketExists, controllers.putObject);
  app.post('/:bucket/:key(*)', controllers.bucketExists, controllers.postObject);
  app.get('/:bucket/:key(*)', controllers.bucketExists, controllers.getObject);
  app.head('/:bucket/:key(*)', controllers.getObject);
  app.delete('/:bucket/:key(*)', controllers.bucketExists, controllers.deleteObject);
  app.post('/:bucket', controllers.bucketExists, controllers.genericPost);

  app.serve = function (done) {
    var server = ((options.key && options.cert) || options.pfx) ? https.createServer(options, app) : app;
    return server.listen(options.port, options.hostname, function (err) {
      return done(err, options.hostname, options.port, options.directory);
    }).on('error', function (err) {
      return done(err);
    });
  };
  return app;
}