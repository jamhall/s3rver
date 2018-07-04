"use strict";

const express = require("express");
const morgan = require("morgan");
const path = require("path");
const { Subject } = require("rxjs");

const controllers = require("./controllers");
const cors = require("./cors");
const createLogger = require("./logger");

module.exports = function(options) {
  const app = express();
  app.s3Event = new Subject();

  /**
   * Log all requests
   */
  app.use(
    morgan("tiny", {
      stream: {
        write(message) {
          app.logger.info(message.slice(0, -1));
        }
      }
    })
  );

  app.use((req, res, next) => {
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
  const middleware = controllers(
    options.directory,
    app.logger,
    options.indexDocument,
    options.errorDocument
  );

  /**
   * Routes for the application
   */
  app.get("/", middleware.getBuckets);
  app.get("/:bucket", middleware.bucketExists, middleware.getBucket);
  app.delete("/:bucket", middleware.bucketExists, middleware.deleteBucket);
  app.put("/:bucket", middleware.putBucket);
  app.put("/:bucket/:key(*)", middleware.bucketExists, middleware.putObject);
  app.post("/:bucket/:key(*)", middleware.bucketExists, middleware.postObject);
  app.get("/:bucket/:key(*)", middleware.bucketExists, middleware.getObject);
  app.head("/:bucket/:key(*)", middleware.getObject);
  app.delete(
    "/:bucket/:key(*)",
    middleware.bucketExists,
    middleware.deleteObject
  );
  app.post("/:bucket", middleware.bucketExists, middleware.genericPost);

  return app;
};
