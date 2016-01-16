'use strict';
var app = function (options) {
  var express = require('express'),
      app = express(),
      logger = require('./logger')(options.silent),
      Controllers = require('./controllers'),
      controllers = new Controllers(options.directory, logger, options.indexDocument, options.errorDocument,options.fs),
      concat = require('concat-stream'),
      path = require('path');

  /**
   * Log all requests
   */
  app.use(require('morgan')('tiny', {
    'stream': {
      write: function (message) {
        logger.info(message.slice(0, -1));
      }
    }
  }));

  app.use(function (req, res, next) {
    req.pipe(concat(function (data) {
      req.body = data;
      next();
    }));
  });

  app.use(function (req, res, next) {
    var host = req.headers.host.split(':')[0];

    if (options.indexDocument && host !== 'localhost' && host !== '127.0.0.1') {
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
  app.get('/:bucket/:key(*)', controllers.bucketExists, controllers.getObject);
  app.head('/:bucket/:key(*)', controllers.getObject);
  app.delete('/:bucket/:key(*)', controllers.bucketExists, controllers.deleteObject);
  app.post('/:bucket', controllers.bucketExists, controllers.genericPost);

  return {
    serve: function (done) {
      return app.listen(options.port, options.hostname, function (err) {
        return done(err, options.hostname, options.port, options.directory);
      }).on('error', function (err) {
        return done(err);
      });
    }
  };
};

module.exports = app;
