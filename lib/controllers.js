"use strict";

const async = require("async");
const concat = require("concat-stream");
const crypto = require("crypto");
const path = require("path");
const { Readable: ReadableStream } = require("stream");
const url = require("url");
const xml2js = require("xml2js");

const FileStore = require("./file-store");
const S3Event = require("./models/s3-event");
const templateBuilder = require("./xml-template-builder");

module.exports = function(rootDirectory, logger, indexDocument, errorDocument) {
  const fileStore = new FileStore(rootDirectory);

  function buildXmlResponse(res, status, template) {
    res.header("Content-Type", "application/xml");
    res.status(status);
    return res.send(template);
  }

  function buildResponse(req, res, status, object, data) {
    res.header("Accept-Ranges", "bytes");
    if (data.range) {
      const end = Math.min(data.range.end || Infinity, object.size - 1);
      res.header(
        "Content-Range",
        "bytes " + data.range.start + "-" + end + "/" + object.size
      );
      res.header("Content-Length", end - data.range.start + 1);
    } else {
      res.header("Content-Length", object.size);
    }

    res.setHeader("Content-Type", object.contentType);

    if (object.contentEncoding)
      res.header("Content-Encoding", object.contentEncoding);

    if (object.contentDisposition)
      res.header("Content-Disposition", object.contentDisposition);

    res.header("Etag", JSON.stringify(object.md5));
    res.header("Last-Modified", new Date(object.modifiedDate).toUTCString());

    if (object.customMetaData.length > 0) {
      for (const { key, value } of object.customMetaData) {
        res.header(key, value);
      }
    }
    res.status(status);

    if (req.method === "HEAD") {
      res.end();
    } else {
      data.pipe(res);
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
      req.bucket.name
    );

    if (indexDocument) {
      if (errorDocument) {
        fileStore.getObject(req.bucket, errorDocument, (err, object, data) => {
          if (err) {
            // eslint-disable-next-line no-console
            console.error("Custom Error Document not found: " + errorDocument);
            return notFoundResponse(req, res);
          } else {
            return buildResponse(req, res, 404, object, data);
          }
        });
      } else {
        return notFoundResponse(req, res);
      }
    } else {
      const template = templateBuilder.buildKeyNotFound(keyName);
      return buildXmlResponse(res, 404, template);
    }
  }

  function notFoundResponse(req, res) {
    const ErrorDoc =
      "<!DOCTYPE html>\n<html><head><title>404 - Resource Not Found</title></head><body><h1>404 - Resource Not Found</h1></body></html>";
    const stream = new ReadableStream();
    stream.push(ErrorDoc);
    stream.push(null);

    return buildResponse(
      req,
      res,
      404,
      {
        modifiedDate: new Date(),
        contentType: "text/html",
        customMetaData: [],
        size: ErrorDoc.length
      },
      stream
    );
  }

  function deleteObjects(req, res) {
    xml2js.parseString(req.body, (err, parsedBody) => {
      const keys = parsedBody.Delete.Object.map(o => o.Key[0]);
      async.each(
        keys,
        (key, cb) => {
          fileStore.getObjectExists(req.bucket, key, err => {
            if (err) return cb();

            fileStore.deleteObject(req.bucket, key, err => {
              if (err) {
                logger.error('Could not delete object "%s"', key, err);
                const template = templateBuilder.buildError(
                  "InternalError",
                  "We encountered an internal error. Please try again."
                );
                cb(err);
                return buildXmlResponse(res, 500, template);
              }
              logger.info(
                'Deleted object "%s" in bucket "%s"',
                key,
                req.bucket.name
              );
              cb();
            });
          });
        },
        err => {
          if (err) return;
          const template = templateBuilder.buildObjectsDeleted(keys);
          return buildXmlResponse(res, 200, template);
        }
      );
    });
  }

  function handleCopyObject(key, req, res) {
    let template;
    let copy = req.headers["x-amz-copy-source"];
    copy = copy.charAt(0) === "/" ? copy : "/" + copy;
    const srcObjectParams = copy.split("/"),
      srcBucket = srcObjectParams[1],
      srcObject = srcObjectParams.slice(2).join("/");
    fileStore.getBucket(srcBucket, (err, bucket) => {
      if (err) {
        logger.error('No bucket found for "%s"', srcBucket);
        template = templateBuilder.buildBucketNotFound(srcBucket);
        return buildXmlResponse(res, 404, template);
      }
      fileStore.getObject(bucket, srcObject, err => {
        if (err) {
          logger.error(
            'Object "%s" in bucket "%s" does not exist',
            srcObject,
            bucket.name
          );
          template = templateBuilder.buildKeyNotFound(srcObject);
          return buildXmlResponse(res, 404, template);
        }

        const replaceMetadata =
          req.headers["x-amz-metadata-directive"] === "REPLACE";
        fileStore.copyObject(
          {
            request: req,
            srcKey: srcObject,
            srcBucket: bucket,
            destBucket: req.bucket,
            destKey: key,
            replaceMetadata: replaceMetadata
          },
          (err, object) => {
            if (err) {
              logger.error(
                'Error copying object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
                srcObject,
                bucket.name,
                req.bucket.name,
                key
              );
              template = templateBuilder.buildError(
                "InternalError",
                "We encountered an internal error. Please try again."
              );
              return buildXmlResponse(res, 500, template);
            }

            logger.info(
              'Copied object "%s" from bucket "%s"  into bucket "%s" with key of "%s"',
              srcObject,
              bucket.name,
              req.bucket.name,
              key
            );
            triggerS3Event(req, res, {
              bucket: req.bucket.name,
              eventType: "Copy",
              S3Item: object
            });
            template = templateBuilder.buildCopyObject(object);
            return buildXmlResponse(res, 200, template);
          }
        );
      });
    });
  }

  function putObjectMultipart(req, res) {
    const partKey = req.query.uploadId + "_" + req.query.partNumber;
    if (req.headers["x-amz-copy-source"]) {
      handleCopyObject(partKey, req, res);
    } else {
      fileStore.putObject(req.bucket, partKey, req, (err, key) => {
        if (err) {
          logger.error(
            'Error uploading object "%s" to bucket "%s"',
            partKey,
            req.bucket.name,
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
          req.bucket.name
        );
        res.header("ETag", JSON.stringify(key.md5));
        return res.status(200).end();
      });
    }
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
      fileStore.getBucket(bucketName, (err, bucket) => {
        if (err) {
          logger.error('No bucket found for "%s"', bucketName);
          const template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        req.bucket = bucket;
        next();
      });
    },

    getBuckets(req, res) {
      const buckets = fileStore.getBuckets();
      logger.info("Fetched %d buckets", buckets.length);
      const template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },

    getBucket(req, res) {
      const options = {
        bucketName: req.bucket.name || null,
        marker: req.query.marker || null,
        prefix: req.query.prefix || null,
        maxKeys: parseInt(req.query["max-keys"]) || 1000,
        delimiter: req.query.delimiter || null
      };

      if (indexDocument) {
        fileStore.getObject(req.bucket, indexDocument, (err, object, data) => {
          if (err) return errorResponse(req, res, indexDocument);
          logger.info("Serving Page: %s", object.key);
          buildResponse(req, res, 200, object, data);
        });
      } else {
        logger.info(
          'Fetched bucket "%s" with options %s',
          req.bucket.name,
          options
        );
        fileStore.getObjects(req.bucket, options, (err, results) => {
          logger.info(
            'Found %d objects for bucket "%s"',
            results.objects.length,
            req.bucket.name
          );
          const template = templateBuilder.buildBucketQuery(options, results);
          return buildXmlResponse(res, 200, template);
        });
      }
    },

    putBucket(req, res) {
      const bucketName = req.params.bucket;
      let template;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if (/^[a-z0-9]+(.?[-a-z0-9]+)*$/.test(bucketName) === false) {
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
      if (bucketName.length < 3 || bucketName.length > 63) {
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
      fileStore.getBucket(bucketName, (err, bucket) => {
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
        fileStore.putBucket(bucketName, err => {
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
      fileStore.deleteBucket(req.bucket, err => {
        if (err) {
          const template = templateBuilder.buildBucketNotEmpty(req.bucket.name);
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
      fileStore.getObject(
        req.bucket,
        keyName,
        req.headers.range,
        (err, object, data) => {
          if (err) {
            if (indexDocument) {
              keyName = path.join(keyName, indexDocument);
              return fileStore.getObject(
                req.bucket,
                keyName,
                (err, object, data) => {
                  if (err) {
                    return errorResponse(req, res, keyName);
                  } else {
                    return buildResponse(req, res, 200, object, data);
                  }
                }
              );
            } else {
              return errorResponse(req, res, keyName);
            }
          }

          const noneMatch = req.headers["if-none-match"];
          if (
            noneMatch &&
            (noneMatch === JSON.stringify(object.md5) || noneMatch === "*")
          ) {
            return res.status(304).end();
          }
          const modifiedSince = req.headers["if-modified-since"];
          if (modifiedSince) {
            const time = new Date(modifiedSince);
            const modifiedDate = new Date(object.modifiedDate);
            if (time >= modifiedDate) {
              return res.status(304).end();
            }
          }

          return buildResponse(
            req,
            res,
            req.headers.range ? 206 : 200,
            object,
            data
          );
        }
      );
    },

    putObject(req, res) {
      if (req.query.uploadId) {
        return putObjectMultipart(req, res);
      }

      if (req.headers["x-amz-copy-source"]) {
        handleCopyObject(req.params.key, req, res);
      } else {
        fileStore.putObject(req.bucket, req.params.key, req, (err, key) => {
          if (err) {
            logger.error(
              'Error uploading object "%s" to bucket "%s"',
              req.params.key,
              req.bucket.name,
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
            req.bucket.name
          );
          triggerS3Event(req, res, {
            bucket: req.bucket.name,
            eventType: "Put",
            S3Item: key
          });
          res.header("ETag", JSON.stringify(key.md5));
          return res.status(200).end();
        });
      }
    },

    postObject(req, res) {
      if (req.query.uploads !== undefined) {
        const uploadId = crypto.randomBytes(16).toString("hex");
        return buildXmlResponse(
          res,
          200,
          templateBuilder.buildInitiateMultipartUploadResult(
            req.bucket.name,
            req.params.key,
            uploadId
          )
        );
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
                req.bucket.name,
                err
              );
              const template = templateBuilder.buildError(
                "XMLParseError",
                err.message
              );
              return buildXmlResponse(res, 400, template);
            }

            const parts = result.CompleteMultipartUpload.Part.map(part => ({
              number: part.PartNumber[0],
              etag: JSON.parse(part.ETag[0])
            }));

            fileStore.combineObjectParts(
              req.bucket,
              req.params.key,
              req.query.uploadId,
              parts,
              req,
              (err, key) => {
                if (err) {
                  logger.error(
                    'Error uploading object "%s" to bucket "%s"',
                    req.params.key,
                    req.bucket.name,
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
                  req.bucket.name
                );
                triggerS3Event(req, res, {
                  bucket: req.bucket.name,
                  eventType: "Post",
                  S3Item: key
                });
                const location =
                  req.protocol +
                  "://" +
                  req.get("Host") +
                  url.parse(req.originalUrl).pathname;
                return buildXmlResponse(
                  res,
                  200,
                  templateBuilder.buildCompleteMultipartUploadResult(
                    req.bucket.name,
                    req.params.key,
                    location,
                    key
                  )
                );
              }
            );
          });
        });
      }
    },

    deleteObject(req, res) {
      const key = req.params.key;
      fileStore.getObjectExists(req.bucket, key, err => {
        if (err) {
          return res.status(204).end();
        }
        fileStore.deleteObject(req.bucket, key, err => {
          if (err) {
            logger.error('Could not delete object "%s"', key, err);
            const template = templateBuilder.buildError(
              "InternalError",
              "We encountered an internal error. Please try again."
            );
            return buildXmlResponse(res, 500, template);
          }
          logger.info(
            'Deleted object "%s" in bucket "%s"',
            key,
            req.bucket.name
          );
          triggerS3Event(req, res, {
            bucket: req.bucket.name,
            eventType: "Delete",
            S3Item: { key: key }
          });
          return res.status(204).end();
        });
      });
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
    }
  };
};
