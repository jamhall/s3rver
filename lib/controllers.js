"use strict";

const async = require("async");
const concat = require("concat-stream");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");
const url = require("url");
const xml2js = require("xml2js");

const S3Event = require("./models/s3-event");
const S3Object = require("./models/s3-object");
const FilesystemStore = require("./stores/filesystem");
const utils = require("./utils");
const templateBuilder = require("./xml-template-builder");

module.exports = function(rootDirectory, logger, indexDocument, errorDocument) {
  const store = new FilesystemStore(rootDirectory);

  function buildXmlResponse(res, status, template) {
    res.header("Content-Type", "application/xml");
    res.status(status);
    return res.send(template);
  }

  function buildResponse(req, res, status, object) {
    res.header("Accept-Ranges", "bytes");

    for (const header in object.metadata) {
      res.setHeader(utils.normalizeHeader(header), object.metadata[header]);
    }
    if (object.range) {
      res.header(
        "Content-Range",
        "bytes " +
          object.range.start +
          "-" +
          object.range.end +
          "/" +
          object.size
      );
      res.header("Content-Length", object.range.end + 1 - object.range.start);
    }

    res.status(status);

    if (req.method === "HEAD") {
      object.content.destroy();
      res.end();
    } else {
      object.content.pipe(res);
    }
  }

  function triggerS3Event(req, res, eventData) {
    res.app.s3Event.next(
      new S3Event(eventData, {
        reqHeaders: req.headers,
        sourceIp: req.connection.remoteAddress
      })
    );
  }

  function errorResponse(req, res, keyName) {
    logger.error(
      'Object "%s" in bucket "%s" does not exist',
      keyName,
      req.params.bucket
    );

    if (!indexDocument) {
      const template = templateBuilder.buildKeyNotFound(keyName);
      return buildXmlResponse(res, 404, template);
    }
    if (!errorDocument) {
      return notFoundResponse(req, res);
    }
    store.getObject(req.params.bucket, errorDocument, (err, object) => {
      if (err) {
        const template = templateBuilder.buildError(
          "InternalError",
          "We encountered an internal error. Please try again."
        );
        return buildXmlResponse(res, 500, template);
      }
      if (!object) {
        // eslint-disable-next-line no-console
        console.error("Custom Error Document not found: " + errorDocument);
        return notFoundResponse(req, res);
      }
      return buildResponse(req, res, 404, object);
    });
  }

  function notFoundResponse(req, res) {
    const errorDoc =
      "<!DOCTYPE html>\n<html><head><title>404 - Resource Not Found</title></head><body><h1>404 - Resource Not Found</h1></body></html>";
    const stream = new Readable();
    stream.push(errorDoc);
    stream.push(null);

    return buildResponse(req, res, 404, {
      content: stream,
      metadata: {
        "content-type": "text/html",
        "last-modified": new Date().toUTCString(),
        "content-length": errorDoc.length
      }
    });
  }

  function deleteObjects(req, res) {
    xml2js.parseString(req.body, (err, parsedBody) => {
      const keys = (parsedBody.Delete.Object || []).map(o => o.Key[0]);
      async.each(
        keys,
        (key, cb) => {
          store.existsObject(req.params.bucket, key, (err, exists) => {
            if (!exists) return cb();

            store.deleteObject(req.params.bucket, key, err => {
              if (err) {
                logger.error('Could not delete object "%s"', key, err);
                return cb(err);
              }
              logger.info(
                'Deleted object "%s" in bucket "%s"',
                key,
                req.params.bucket
              );
              cb();
            });
          });
        },
        err => {
          if (err) {
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          const template = templateBuilder.buildObjectsDeleted(keys);
          return buildXmlResponse(res, 200, template);
        }
      );
    });
  }

  function copyObject(req, res) {
    let copySource = decodeURI(req.headers["x-amz-copy-source"]);
    copySource = copySource.startsWith("/") ? copySource.slice(1) : copySource;
    let [srcBucket, ...srcKey] = copySource.split("/");
    srcKey = srcKey.join("/");

    const destBucket = req.params.bucket;
    const destKey = req.params.key;

    store.getBucket(srcBucket, (err, bucket) => {
      if (err) {
        const template = templateBuilder.buildError(
          "InternalError",
          "We encountered an internal error. Please try again."
        );
        return buildXmlResponse(res, 500, template);
      }
      if (!bucket) {
        logger.error('No bucket found for "%s"', srcBucket);
        const template = templateBuilder.buildBucketNotFound(srcBucket);
        return buildXmlResponse(res, 404, template);
      }

      store.existsObject(srcBucket, srcKey, (err, exists) => {
        if (err) {
          logger.error('Could not copy object "%s"', srcKey, err);
          const template = templateBuilder.buildError(
            "InternalError",
            "We encountered an internal error. Please try again."
          );
          return buildXmlResponse(res, 500, template);
        }
        if (!exists) {
          logger.error(
            'Object "%s" in bucket "%s" does not exist',
            srcKey,
            srcBucket
          );
          const template = templateBuilder.buildKeyNotFound(srcKey);
          return buildXmlResponse(res, 404, template);
        }

        const replaceMetadata =
          req.headers["x-amz-metadata-directive"] === "REPLACE";
        if (
          srcBucket === destBucket &&
          srcKey === destKey &&
          !replaceMetadata
        ) {
          const template = templateBuilder.buildError(
            "InvalidRequest",
            "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, " +
              "storage class, website redirect location or encryption attributes."
          );
          return buildXmlResponse(res, 400, template);
        }

        store.copyObject(
          srcBucket,
          srcKey,
          destBucket,
          destKey,
          replaceMetadata ? req.headers : null,
          (err, metadata) => {
            if (err) {
              logger.error(
                'Error copying object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
                srcKey,
                srcBucket,
                destBucket,
                destKey
              );
              const template = templateBuilder.buildError(
                "InternalError",
                "We encountered an internal error. Please try again."
              );
              return buildXmlResponse(res, 500, template);
            }

            logger.info(
              'Copied object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
              srcKey,
              srcBucket,
              destBucket,
              destKey
            );
            triggerS3Event(req, res, {
              bucket: req.params.bucket,
              eventType: "Copy",
              S3Item: new S3Object(destBucket, destKey, null, metadata)
            });
            const template = templateBuilder.buildCopyObject(metadata);
            return buildXmlResponse(res, 200, template);
          }
        );
      });
    });
  }

  function putObjectMultipart(req, res) {
    const partKey = req.query.uploadId + "_" + req.query.partNumber;
    const object = new S3Object(req.params.bucket, partKey, req, req.headers);
    store.putObject(object, (err, md5) => {
      if (err) {
        logger.error(
          'Error uploading object "%s" to bucket "%s"',
          partKey,
          req.params.bucket,
          err
        );
        const template = templateBuilder.buildError(
          "InternalError",
          "We encountered an internal error. Please try again."
        );
        return buildXmlResponse(res, 500, template);
      }
      logger.info(
        'Stored object "%s" in bucket "%s" successfully',
        partKey,
        req.params.bucket
      );
      res.header("ETag", JSON.stringify(md5));
      return res.status(200).end();
    });
  }

  /**
   * The following methods correspond the S3 api. For more information visit:
   * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
   */
  return {
    /**
     * Middleware to check if a bucket exists
     */
    bucketExists(req, res, next) {
      const bucketName = req.params.bucket;
      store.getBucket(bucketName, (err, bucket) => {
        if (err) {
          const template = templateBuilder.buildError(
            "InternalError",
            "We encountered an internal error. Please try again."
          );
          return buildXmlResponse(res, 500, template);
        }
        if (!bucket) {
          logger.error('No bucket found for "%s"', bucketName);
          const template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        req.bucket = bucket;
        next();
      });
    },

    getBuckets(req, res) {
      const buckets = store.getBuckets();
      logger.info("Fetched %d buckets", buckets.length);
      const template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },

    getBucket(req, res) {
      if (indexDocument) {
        store.getObject(req.params.bucket, indexDocument, (err, object) => {
          if (!object) return errorResponse(req, res, indexDocument);
          logger.info("Serving Page: %s", object.key);
          buildResponse(req, res, 200, object);
        });
      } else {
        const options = {
          delimiter: req.query["delimiter"],
          marker: req.query["marker"],
          maxKeys: Math.min(1000, parseInt(req.query["max-keys"]) || Infinity),
          prefix: req.query["prefix"]
        };
        logger.info(
          'Fetched bucket "%s" with options %s',
          req.params.bucket,
          options
        );
        store.listObjects(req.params.bucket, options, (err, results) => {
          if (err) {
            logger.error(
              'Error listing objects in bucket "%s"',
              req.params.bucket
            );
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          logger.info(
            'Found %d objects for bucket "%s"',
            results.objects.length,
            req.params.bucket
          );
          const template = templateBuilder.buildBucketQuery(
            req.params.bucket,
            options,
            results
          );
          buildXmlResponse(res, 200, template);
        });
      }
    },

    putBucket(req, res) {
      const bucketName = req.params.bucket;
      let template;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if (!/^[a-z0-9]+(.?[-a-z0-9]+)*$/.test(bucketName)) {
        template = templateBuilder.buildError(
          "InvalidBucketName",
          "Bucket names can contain lowercase letters, numbers, and hyphens. " +
            "Each label must start and end with a lowercase letter or a number."
        );
        logger.error(
          'Error creating bucket "%s" because the name is invalid',
          bucketName
        );
        return buildXmlResponse(res, 400, template);
      }
      if (bucketName.length < 3 || 63 < bucketName.length) {
        logger.error(
          'Error creating bucket "%s" because the name is invalid',
          bucketName
        );
        template = templateBuilder.buildError(
          "InvalidBucketName",
          "The bucket name must be between 3 and 63 characters."
        );
        return buildXmlResponse(res, 400, template);
      }
      store.getBucket(bucketName, (err, bucket) => {
        if (bucket) {
          logger.error(
            'Error creating bucket. Bucket "%s" already exists',
            bucketName
          );
          const template = templateBuilder.buildError(
            "BucketAlreadyExists",
            "The requested bucket already exists"
          );
          return buildXmlResponse(res, 409, template);
        }
        store.putBucket(bucketName, err => {
          if (err) {
            logger.error('Error creating bucket "%s"', err);
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Created new bucket "%s" successfully', bucketName);
          res.header("Location", "/" + bucketName);
          return res.status(200).send();
        });
      });
    },

    deleteBucket(req, res) {
      store.deleteBucket(req.params.bucket, err => {
        if (err) {
          const template = templateBuilder.buildBucketNotEmpty(
            req.params.bucket
          );
          return buildXmlResponse(res, 409, template);
        }
        return res.status(204).end();
      });
    },

    getObject(req, res) {
      let keyName = req.params.key;
      const acl = req.query.acl;
      if (acl !== undefined) {
        const template = templateBuilder.buildAcl();
        return buildXmlResponse(res, 200, template);
      }
      const options = {};
      if (/^bytes=/.test(req.headers["range"])) {
        const [start, end] = req.headers["range"]
          .replace("bytes=", "")
          .split("-");
        options.start = parseInt(start);
        if (end) options.end = parseInt(end);
      }
      store.getObject(req.params.bucket, keyName, options, (err, object) => {
        if (!object) {
          if (!indexDocument) return errorResponse(req, res, keyName);
          keyName = path.posix.join(keyName, indexDocument);
          return store.getObject(req.params.bucket, keyName, (err, object) => {
            if (!object) return errorResponse(req, res, keyName);
            buildResponse(req, res, 200, object);
          });
        }

        const noneMatch = req.headers["if-none-match"];
        if (
          noneMatch &&
          (noneMatch === object.metadata["etag"] || noneMatch === "*")
        ) {
          return res.status(304).end();
        }
        const modifiedSince = req.headers["if-modified-since"];
        if (new Date(modifiedSince) >= object.lastModifiedDate) {
          return res.status(304).end();
        }

        return buildResponse(req, res, object.range ? 206 : 200, object);
      });
    },

    putObject(req, res) {
      if (req.headers["x-amz-copy-source"]) {
        copyObject(req, res);
      } else if (req.query.uploadId) {
        putObjectMultipart(req, res);
      } else {
        const object = new S3Object(
          req.params.bucket,
          req.params.key,
          req,
          req.headers
        );
        store.putObject(object, (err, md5, size) => {
          if (err) {
            logger.error(
              'Error uploading object "%s" to bucket "%s"',
              object.key,
              object.bucket,
              err
            );
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          logger.info(
            'Stored object "%s" in bucket "%s" successfully',
            object.key,
            object.bucket
          );
          triggerS3Event(req, res, {
            bucket: req.params.bucket,
            eventType: "Put",
            S3Item: new S3Object(object.bucket, object.key, null, {
              "content-length": size,
              etag: JSON.stringify(md5)
            })
          });
          res.header("ETag", JSON.stringify(md5));
          return res.status(200).end();
        });
      }
    },

    genericPost(req, res) {
      if (req.query.delete !== undefined) {
        req.pipe(
          concat(data => {
            req.body = data;
            deleteObjects(req, res);
          })
        );
      } else {
        notFoundResponse(req, res);
      }
    },

    postObject(req, res) {
      if (req.query.uploads !== undefined) {
        const uploadId = crypto.randomBytes(16).toString("hex");
        const template = templateBuilder.buildInitiateMultipartUploadResult(
          req.params.bucket,
          req.params.key,
          uploadId
        );
        return buildXmlResponse(res, 200, template);
      } else {
        let completeMultipartUploadXml = "";

        req.on("data", data => {
          completeMultipartUploadXml += data.toString("utf8");
        });

        req.on("end", () => {
          xml2js.parseString(completeMultipartUploadXml, (err, result) => {
            if (err) {
              logger.error(
                'Error completing multipart upload "%s" for object "%s" in bucket "%s"',
                req.query.uploadId,
                req.params.key,
                req.params.bucket,
                err
              );
              const template = templateBuilder.buildError(
                "XMLParseError",
                err.message
              );
              return buildXmlResponse(res, 400, template);
            }

            const parts = result.CompleteMultipartUpload.Part.map(part => ({
              number: parseInt(part.PartNumber[0]),
              etag: JSON.parse(part.ETag[0])
            }));

            store.putObjectMultipart(
              req.params.bucket,
              req.params.key,
              req.query.uploadId,
              parts,
              req.headers,
              (err, md5, size) => {
                if (err) {
                  logger.error(
                    'Error uploading object "%s" to bucket "%s"',
                    req.params.key,
                    req.params.bucket,
                    err
                  );
                  const template = templateBuilder.buildError(
                    "InternalError",
                    "We encountered an internal error. Please try again."
                  );
                  return buildXmlResponse(res, 500, template);
                }
                logger.info(
                  'Stored object "%s" in bucket "%s" successfully',
                  req.params.key,
                  req.params.bucket
                );
                triggerS3Event(req, res, {
                  bucket: req.params.bucket,
                  eventType: "Post",
                  S3Item: new S3Object(
                    req.params.bucket,
                    req.params.key,
                    null,
                    { etag: JSON.stringify(md5), "content-length": size }
                  )
                });
                // prettier-ignore
                const location = `${req.protocol}://${req.headers["host"]}${url.parse(req.originalUrl).pathname}`;
                const template = templateBuilder.buildCompleteMultipartUploadResult(
                  req.params.bucket,
                  req.params.key,
                  location,
                  md5
                );
                return buildXmlResponse(res, 200, template);
              }
            );
          });
        });
      }
    },

    deleteObject(req, res) {
      store.existsObject(req.params.bucket, req.params.key, (err, exists) => {
        if (err) {
          logger.error(
            'Error deleting object "%s" from bucket "%s"',
            req.params.key,
            req.params.bucket,
            err
          );
          const template = templateBuilder.buildError(
            "InternalError",
            "We encountered an internal error. Please try again."
          );
          return buildXmlResponse(res, 500, template);
        }
        if (!exists) return res.status(204).end();

        store.deleteObject(req.params.bucket, req.params.key, err => {
          if (err) {
            logger.error('Could not delete object "%s"', req.params.key, err);
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          logger.info(
            'Deleted object "%s" in bucket "%s"',
            req.params.key,
            req.params.bucket
          );
          triggerS3Event(req, res, {
            bucket: req.params.bucket,
            eventType: "Delete",
            S3Item: { key: req.params.key }
          });
          res.status(204).end();
        });
      });
    }
  };
};
