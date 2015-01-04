var path = require('path');
var fs = require('fs');
var debug = require('debug')('FileStore');
var async = require('async');
var md5 = require('MD5');
var mkdirp = require('mkdirp');
var FileStore = function (rootDirectory) {
  var CONTENT_FILE = '.dummys3_content', METADATA_FILE = '.dummys3_metadata', Bucket = require('./models/bucket'), S3Object = require('./models/s3-object');
  var getAllBuckets = function () {
    var buckets = [];
    fs.readdirSync(rootDirectory).filter(function (result) {
      var file = fs.statSync(path.resolve(rootDirectory, result));
      if (file.isDirectory()) {
        buckets.push(new Bucket(result, file.ctime));
      }
    });
    return buckets;
  };
  var getBucket = function (bucketName, done) {
    fs.stat(path.resolve(rootDirectory, bucketName), function (err, file) {
      if (err || !file.isDirectory()) {
        return done('Bucket not found');
      }
      return done(null, new Bucket(bucketName, file.ctime));
    });
  };
  var deleteBucket = function (bucket, done) {
    var directory = path.resolve(rootDirectory, bucket.name);
    fs.rmdir(directory, function (err) {
      if (err) {
        return done(err);
      }
      return done();
    });
  };
  var createBucket = function (bucketName, done) {
    var directory = path.resolve(rootDirectory, bucketName);
    fs.mkdir(directory, 502, function (err) {
      return getBucket(bucketName, done);
    });
  };
  var getKey = function (bucket, key, done) {
    var filePath = path.resolve(rootDirectory, bucket.name, key);
    fs.exists(filePath, function (exists) {
      if (exists === false) {
        return done('Not found');
      }
      async.parallel([
        function (callback) {
          fs.readFile(path.join(filePath, CONTENT_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            return callback(null, data);
          });
        },
        function (callback) {
          fs.readFile(path.join(filePath, METADATA_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            callback(null, new S3Object(buildMetadataFromFile(data)));
          });
        }
      ], function (err, results) {
        if (err) {
          return done(erR);
        }
        return done(null, results[1], results[0]);
      });
    });
  };
  // TODO
  var getAllKeysForBucket = function (bucket, options, done) {
    var matches = [];
    var walk = require('walk'), fs = require('fs'), options, walker;
    options = {
      followLinks: true  // directories with these keys will be skipped
    };
    walker = walk.walk(path.join(rootDirectory, bucket.name), options);
    walker.on('directories', function (root, dirStatsArray, next) {
      async.eachSeries(dirStatsArray, function (directory, callback) {
        fs.readFile(path.join(root, directory.name, METADATA_FILE), function (err, data) {
          if (data) {
            matches.push(new S3Object(buildMetadataFromFile(data)));
          }
          callback(null);
        });
      }, function (err) {
        if (err) {
          // One of the iterations produced an error.
          // All processing will now stop.
          console.log('A file failed to process');
        } else {
          console.log('All files have been processed successfully');
          next();
        }
      });
    });
    walker.on('end', function () {
      console.log('MATCHES', matches);
      return done(null, matches);
    });
  };
  var buildMetadataFromFile = function (file) {
    var json = JSON.parse(file);
    var metaData = {
      key: json.key,
      md5: json.md5,
      contentType: json.contentType,
      size: json.size,
      modifiedDate: json.modifiedDate,
      creationDate: json.creationDate
    };
    return metaData;
  };
  var getCustomMetaData = function (headers) {
    var customMetaData = [];
    for (header in headers) {
      if (/^x-amz-meta-(.*)$/.test(header)) {
        customMetaData.push(header);
      }
    }
    return customMetaData;
  };
  var createMetaData = function (data, done) {
    var contentFile = data.contentFile, type = data.type, key = data.key, metaFile = data.metaFile, headers = data.headers;
    async.parallel([
      function (callback) {
        fs.stat(contentFile, function (err, stats) {
          if (err) {
            return callback(err);
          }
          return callback(null, {
            mtime: stats.mtime,
            ctime: stats.ctime
          });
        });
      },
      function (callback) {
        fs.readFile(contentFile, function (err, data) {
          return callback(null, {
            size: data.length,
            md5: md5(data)
          });
        });
      }
    ], function (err, results) {
      var metaData = {
        key: key,
        md5: results[1].md5,
        contentType: type,
        size: results[1].size,
        modifiedDate: results[0].mtime,
        creationDate: results[0].ctime,
        customMetadata: getCustomMetaData(headers)
      };
      fs.writeFile(metaFile, JSON.stringify(metaData), function (err) {
        return done(null, metaData);
      });
    });
  };
  var storeKey = function (bucket, req, done) {
    var keyName = path.join(bucket.name, req.params.key);
    var dirName = path.join(rootDirectory, keyName);
    mkdirp.sync(dirName);
    var contentFile = path.join(dirName, CONTENT_FILE);
    var metaFile = path.join(dirName, METADATA_FILE);
    if (/^multipart\/form-data; boundary=.+$/.test(req.headers['content-type'])) {
      var file = req.files.file;
      var type = file.type;
      var key = req.params.key;
      var key = key.substr(key.lastIndexOf('/') + 1);
      fs.readFile(file.path, function (err, data) {
        if (err) {
          return done('Error reading file');
        }
        fs.writeFile(contentFile, data, function (err) {
          if (err) {
            debug('Error writing file', err);
            return done('Error writing file');
          }
          createMetaData({
            contentFile: contentFile,
            type: type,
            key: key,
            metaFile: metaFile,
            headers: req.headers
          }, function (err, metaData) {
            if (err) {
              return done('Error uploading file');
            }
            return done(null, new S3Object(metaData));
          });
        });
      });
    }
  };
  return {
    getAllBuckets: getAllBuckets,
    getBucket: getBucket,
    createBucket: createBucket,
    storeKey: storeKey,
    getAllKeysForBucket: getAllKeysForBucket,
    getKey: getKey,
    deleteBucket: deleteBucket
  };
};
module.exports = FileStore;