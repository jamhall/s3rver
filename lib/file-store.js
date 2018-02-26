"use strict";

const async = require("async");
const crypto = require("crypto");
const fs = require("fs-extra");
const { sortBy } = require("lodash");
const path = require("path");
const { PassThrough } = require("stream");

const Bucket = require("./models/bucket");
const S3Object = require("./models/s3-object");
const utils = require("./utils");

const CONTENT_FILE = ".dummys3_content";
const METADATA_FILE = ".dummys3_metadata";

class FileStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  // helpers
  getBucketPath(bucketName) {
    return path.join(this.rootDirectory, bucketName);
  }

  buildS3ObjectFromMetaDataFile(key, file) {
    const json = JSON.parse(file);
    const metaData = {
      key: key,
      md5: json.md5,
      contentType: json.contentType,
      contentEncoding: json.contentEncoding,
      contentDisposition: json.contentDisposition,
      size: json.size,
      modifiedDate: json.modifiedDate,
      creationDate: json.creationDate,
      customMetaData: json.customMetaData
    };
    return new S3Object(metaData);
  }

  getCustomMetaData(headers) {
    const customMetaData = [];
    for (const header in headers) {
      if (header.startsWith("x-amz-meta-")) {
        customMetaData.push({
          key: header,
          value: headers[header]
        });
      }
    }
    return customMetaData;
  }

  createMetaData(
    { key, contentFile, metaFile, type, encoding, disposition, headers },
    done
  ) {
    async.parallel(
      [
        callback => fs.stat(contentFile, callback),
        callback => {
          let length = 0;
          const md5 = crypto.createHash("md5");
          const stream = fs.createReadStream(contentFile);

          stream.on("error", err => {
            return callback(err);
          });

          stream.on("data", data => {
            length += data.length;
            md5.update(data, "utf8");
          });

          stream.on("end", () => {
            return callback(null, {
              size: length,
              md5: md5.digest("hex")
            });
          });
        }
      ],
      (err, results) => {
        const metaData = {
          key: key,
          creationDate: results[0].ctime,
          modifiedDate: results[0].mtime,
          md5: results[1].md5,
          size: results[1].size,
          customMetaData: this.getCustomMetaData(headers)
        };
        if (type) metaData.contentType = type;
        if (encoding) metaData.contentEncoding = encoding;
        if (disposition) metaData.contentDisposition = disposition;

        fs.writeFile(metaFile, JSON.stringify(metaData), err => {
          if (err) return done(err);
          done(null, metaData);
        });
      }
    );
  }

  getObjectExists(bucket, key, done) {
    const keyPath = path.resolve(this.getBucketPath(bucket.name), key);
    fs.stat(keyPath, (err, file) => {
      if (err || !file.isDirectory()) {
        return done("Object not found for " + keyPath);
      }
      done();
    });
  }

  concatStreams(passThrough, streams) {
    const stream = streams.shift();
    if (!stream) {
      passThrough.end();
      return passThrough;
    }
    stream.once("end", () => {
      this.concatStreams(passThrough, streams);
    });
    stream.pipe(passThrough, { end: false });
    return passThrough;
  }

  // store implementation

  getBuckets() {
    const buckets = [];
    fs.readdirSync(this.rootDirectory).filter(result => {
      const file = fs.statSync(path.resolve(this.rootDirectory, result));
      if (file.isDirectory()) {
        buckets.push(new Bucket(result, file.ctime));
      }
    });
    return buckets;
  }

  getBucket(bucketName, done) {
    const bucketPath = this.getBucketPath(bucketName);
    fs.stat(bucketPath, (err, file) => {
      if (err || !file.isDirectory()) {
        return done("Bucket not found");
      }
      done(null, new Bucket(bucketName, file.ctime));
    });
  }

  putBucket(bucketName, done) {
    const bucketPath = this.getBucketPath(bucketName);
    fs.mkdirp(bucketPath, 502, err => {
      if (err) return done(err);
      this.getBucket(bucketName, done);
    });
  }

  deleteBucket(bucket, done) {
    const bucketPath = this.getBucketPath(bucket.name);
    fs.rmdir(bucketPath, done);
  }

  getObjects(bucket, options, done) {
    const bucketPath = this.getBucketPath(bucket.name);
    const objects = [];
    const commonPrefixes = [];
    const keys = utils.walk(bucketPath);

    if (!keys.length) {
      return done(null, {
        objects: [],
        commonPrefixes: []
      });
    }

    let filteredKeys = [];
    if (options.delimiter && options.prefix) {
      for (const key of keys) {
        const truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.slice(0, options.prefix.length) == options.prefix) {
          if (
            truncatedKey.indexOf(options.delimiter, options.prefix.length + 1) >
            -1
          ) {
            const commonPrefix = truncatedKey.substring(
              0,
              truncatedKey.indexOf(
                options.delimiter,
                options.prefix.length + 1
              ) + 1
            );
            if (commonPrefixes.indexOf(commonPrefix) == -1) {
              commonPrefixes.push(commonPrefix);
              commonPrefixes.sort();
            }
          } else {
            filteredKeys.push(key);
          }
        }
      }
    } else if (options.prefix) {
      for (const key of keys) {
        const truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.slice(0, options.prefix.length) == options.prefix) {
          filteredKeys.push(key);
        }
      }
    } else if (options.delimiter) {
      for (const key of keys) {
        const truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.indexOf(options.delimiter) > -1) {
          const commonPrefix = truncatedKey.substring(
            0,
            truncatedKey.indexOf(options.delimiter) + 1
          );
          if (commonPrefixes.indexOf(commonPrefix) == -1) {
            commonPrefixes.push(commonPrefix);
            commonPrefixes.sort();
          }
        } else {
          filteredKeys.push(key);
        }
      }
    } else {
      filteredKeys = keys;
    }

    filteredKeys.sort();
    if (options.marker) {
      let startAt = 0;
      let found = false;
      filteredKeys.forEach((key, index) => {
        if (options.marker == key.replace(bucketPath + "/", "")) {
          startAt = index + 1;
          found = true;
        }
      });
      filteredKeys = found ? filteredKeys.slice(startAt) : [];
    }

    filteredKeys = filteredKeys.slice(0, options.maxKeys);

    async.eachSeries(
      filteredKeys,
      (key, callback) => {
        key = key.replace(/\\/g, "/");
        fs.readFile(path.join(key, METADATA_FILE), (err, data) => {
          if (!err) {
            objects.push(
              this.buildS3ObjectFromMetaDataFile(
                key.replace(bucketPath + "/", ""),
                data
              )
            );
          }
          callback();
        });
      },
      () => done(null, { objects, commonPrefixes })
    );
  }

  getObject(bucket, key, range, done) {
    if (typeof range === "function") {
      done = range;
      range = null;
    }
    const filePath = path.resolve(this.getBucketPath(bucket.name), key);
    fs.stat(filePath, err => {
      if (err && err.code === "ENOENT") return done("Not found");

      const options = {};
      if (range && range.startsWith("bytes=")) {
        const [start, end] = range.replace("bytes=", "").split("-");
        options.start = parseInt(start, 10);
        if (end) options.end = parseInt(end, 10);
      }
      async.parallel(
        [
          callback => {
            const readStream = fs.createReadStream(
              path.join(filePath, CONTENT_FILE),
              options
            );
            readStream.range = range && options;
            readStream.on("error", callback);
            readStream.on("open", () => callback(null, readStream));
          },
          callback => {
            fs.readFile(path.join(filePath, METADATA_FILE), (err, data) => {
              if (err) return callback(err);
              callback(null, this.buildS3ObjectFromMetaDataFile(key, data));
            });
          }
        ],
        (err, results) => {
          if (err) return done(err);
          return done(null, results[1], results[0]);
        }
      );
    });
  }

  putObject(bucket, key, req, done) {
    const keyName = path.join(bucket.name, key);
    const dirName = path.join(this.rootDirectory, keyName);
    fs.mkdirpSync(dirName);
    const contentFile = path.join(dirName, CONTENT_FILE);
    const metaFile = path.join(dirName, METADATA_FILE);
    const writeStream = req.pipe(fs.createWriteStream(contentFile));
    writeStream.on("error", done);
    writeStream.on("close", () => {
      writeStream.end();
      this.createMetaData(
        {
          contentFile: contentFile,
          type: req.headers["content-type"],
          encoding: req.headers["content-encoding"],
          disposition: req.headers["content-disposition"],
          key: key,
          metaFile: metaFile,
          headers: req.headers
        },
        (err, metaData) => {
          if (err) return done("Error uploading file");
          done(null, new S3Object(metaData));
        }
      );
    });
  }

  copyObject(
    { request, srcBucket, srcKey, destBucket, destKey, replaceMetadata },
    done
  ) {
    const srcKeyPath = path.join(this.getBucketPath(srcBucket.name), srcKey);
    const destKeyPath = path.join(this.getBucketPath(destBucket.name), destKey);
    const srcContentFilePath = path.join(srcKeyPath, CONTENT_FILE);
    const srcMetadataFilePath = path.join(srcKeyPath, METADATA_FILE);
    const destContentFilePath = path.join(destKeyPath, CONTENT_FILE);
    const destMetadataFilePath = path.join(destKeyPath, METADATA_FILE);

    if (srcKeyPath !== destKeyPath) {
      fs.mkdirpSync(destKeyPath);
      fs.copySync(srcContentFilePath, destContentFilePath);
    }

    if (replaceMetadata) {
      const originalObject = this.buildS3ObjectFromMetaDataFile(
        srcKey,
        fs.readFileSync(srcMetadataFilePath)
      );
      this.createMetaData(
        {
          key: destKey,
          contentFile: destContentFilePath,
          metaFile: destMetadataFilePath,
          type: originalObject.contentType,
          encoding: originalObject.contentEncoding,
          disposition: originalObject.contentDisposition,
          headers: request.headers
        },
        (err, metaData) => {
          if (err) return done("Error updating metadata");
          done(null, new S3Object(metaData));
        }
      );
    } else if (srcKeyPath !== destKeyPath) {
      fs.copySync(srcMetadataFilePath, destMetadataFilePath);
      fs.readFile(destMetadataFilePath, (err, data) => {
        if (err) return done(err);
        done(null, this.buildS3ObjectFromMetaDataFile(destKey, data));
      });
    }
  }

  deleteObject(bucket, key, done) {
    const bucketPath = this.getBucketPath(bucket.name);
    const keyPath = path.resolve(bucketPath, key);
    async.map(
      [path.join(keyPath, CONTENT_FILE), path.join(keyPath, METADATA_FILE)],
      fs.unlink,
      err => {
        if (err) return done(err);
        fs.rmdir(keyPath, () => {
          utils.removeEmptyDirectories(fs, bucketPath, () => {
            return done();
          });
        });
      }
    );
  }

  combineObjectParts(bucket, key, uploadId, parts, req, done) {
    const sortedParts = sortBy(parts, part => part.number);
    const partPaths = sortedParts.map(part => {
      return path.join(
        this.getBucketPath(bucket.name),
        uploadId + "_" + part.number
      );
    });
    const partStreams = partPaths.map(partPath =>
      fs.createReadStream(path.join(partPath, CONTENT_FILE))
    );
    const combinedPartsStream = this.concatStreams(
      new PassThrough(),
      partStreams
    );
    const keyName = path.join(bucket.name, key);
    const dirName = path.join(this.rootDirectory, keyName);
    fs.mkdirpSync(dirName);
    const contentFile = path.join(dirName, CONTENT_FILE);
    const metaFile = path.join(dirName, METADATA_FILE);
    const writeStream = combinedPartsStream.pipe(
      fs.createWriteStream(contentFile)
    );
    writeStream.on("error", done);
    writeStream.on("close", () => {
      writeStream.end();
      partPaths.forEach(partPath => fs.removeSync(partPath));
      this.createMetaData(
        {
          key,
          contentFile,
          metaFile,
          type: req.headers["content-type"],
          encoding: req.headers["content-encoding"],
          disposition: req.headers["content-disposition"],
          headers: req.headers
        },
        (err, metaData) => {
          if (err) return done(err);
          done(null, new S3Object(metaData));
        }
      );
    });
  }
}

module.exports = FileStore;
