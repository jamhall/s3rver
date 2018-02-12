"use strict";

const express = require("express");
const morgan = require("morgan");
const path = require("path");

const Controllers = require("./controllers");
const cors = require("./cors");
const createLogger = require("./logger");
const subject = require("rxjs/Subject").Subject;
require("rxjs/add/operator/filter");

module.exports = function(options) {
  const app = express();
  app.s3Event = new subject();

  /**
   * Log all requests
   */
  app.use(
    morgan("tiny", {
      stream: {
        write: function(message) {
          app.logger.info(message.slice(0, -1));
        }
      }
    })
  );

  app.use(function(req, res, next) {
    const host = req.headers.host.split(":")[0];

    // Handle requests for <bucket>.s3(-<region>?).amazonaws.com, if they arrive.
    const bucket = (/(.+)\.s3(-.+)?\.amazonaws\.com$/.exec(host) || [])[1];
    if (bucket) {
      req.url = path.join("/", bucket, req.url);
    } else if (
      options.indexDocument &&
      host !== "localhost" &&
      host !== "127.0.0.1"
    ) {
      req.url = path.join("/", host, req.url);
    }

    next();
  });

  app.use(cors(options.cors));

  app.disable("x-powered-by");

  // Don't register logger until app is successfully set up
  app.logger = createLogger(options.silent);
  const controllers = new Controllers(
    options.directory,
    app.logger,
    options.indexDocument,
    options.errorDocument
  );

  /**
   * Routes for the application
   */
  app.get("/", controllers.getBuckets);
  app.get("/:bucket", controllers.bucketExists, controllers.getBucket);
  app.delete("/:bucket", controllers.bucketExists, controllers.deleteBucket);
  app.put("/:bucket", controllers.putBucket);
  app.put("/:bucket/:key(*)", controllers.bucketExists, controllers.putObject);
  app.post(
    "/:bucket/:key(*)",
    controllers.bucketExists,
    controllers.postObject
  );
  app.get("/:bucket/:key(*)", controllers.bucketExists, controllers.getObject);
  app.head("/:bucket/:key(*)", controllers.getObject);
  app.delete(
    "/:bucket/:key(*)",
    controllers.bucketExists,
    controllers.deleteObject
  );
  app.post("/:bucket", controllers.bucketExists, controllers.genericPost);

  return app;
};
