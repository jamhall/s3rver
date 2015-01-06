'use strict';
var app = function (hostname, port, directory, silent) {
  var express = require('express'),
      app = express(),
      Controllers = require('./controllers'),
      controllers = new Controllers(directory),
      logger = require('./logger'),
      concat = require('concat-stream');
  /**
   * Log all requests
   */
  app.use(require('morgan')('tiny', { 'stream': logger.stream }));

  app.use(function (req, res, next) {
    req.pipe(concat(function (data) {
      req.body = data;
      next();
    }));
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

  return {
    serve: function (done) {
      app.listen(port, function () {
        return done(null, hostname, port);
      });
    }
  }
};

module.exports = app;
