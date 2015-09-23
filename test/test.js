'use strict';
var AWS = require('aws-sdk');
var async = require('async');
var should = require('should');
var fs = require('fs-extra');
var _ = require('lodash');
var moment = require('moment');
var Chance = require('chance');
var chance = new Chance();
var path = require('path');
var md5 = require('MD5');
var S3rver = require('../lib');
var util = require('util');
var request = require('request');

describe('S3rver Tests', function () {
  var s3Client;
  var buckets = ['bucket1', 'bucket2', 'bucket3', 'bucket4', 'bucket5'];
  var s3rver;
  before(function (done) {
    s3rver = new S3rver({
      port: 4569,
      hostname: 'localhost',
      silent: true,
      indexDocument: '',
      errorDocument: '',
      directory: '/tmp/s3rver_test_directory'
    }).run(function (err, hostname, port, directory) {
        if (err) {
          return done('Error starting server', err);
        }
        var config = {
          accessKeyId: '123',
          secretAccessKey: 'abc',
          endpoint: util.format('%s:%d', hostname, port),
          sslEnabled: false,
          s3ForcePathStyle: true
        };
        AWS.config.update(config);
        s3Client = new AWS.S3();
        s3Client.endpoint = new AWS.Endpoint(config.endpoint);
        /**
         * Remove if exists and recreate the temporary directory
         */
        fs.remove(directory, function (err) {
          if (err) {
            return done(err);
          }
          fs.mkdirs(directory, function (err) {
            if (err) {
              return done(err);
            }

            // Create 5 buckets
            async.eachSeries(buckets, function (bucket, callback) {
              s3Client.createBucket({Bucket: bucket}, callback);
            }, done);
          });
        });
      });
  });

  after(function (done) {
    s3rver.close(done);
  });

  it('should fetch fetch five buckets', function (done) {
    s3Client.listBuckets(function (err, buckets) {
      if (err) {
        return done(err);
      }
      buckets.Buckets.length.should.equal(5);
      _.forEach(buckets.Buckets, function (bucket) {
        should.exist(bucket.Name);
        moment(bucket.CreationDate).isValid().should.equal(true);
      });
      done();
    });
  });

  it('should fail to create a bucket because of invalid name', function (done) {
    s3Client.createBucket({Bucket: '-$%!nvalid'}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too long', function (done) {
    s3Client.createBucket({Bucket: chance.string({length: 64, pool: 'abcd'})}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too short', function (done) {
    s3Client.createBucket({Bucket: 'ab'}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should delete a bucket', function (done) {
    s3Client.deleteBucket({Bucket: buckets[4]}, function (err) {
      if (err) {
        return done(err);
      }
      return done();
    });
  });

  it('should not fetch the deleted bucket', function (done) {
    s3Client.listObjects({Bucket: buckets[4]}, function (err) {
      err.code.should.equal('NoSuchBucket');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should list no objects for a bucket', function (done) {
    s3Client.listObjects({Bucket: buckets[3]}, function (err, objects) {
      if (err) {
        return done(err);
      }
      objects.Contents.length.should.equal(0);
      done();
    });
  });

  it('should store a text object in a bucket', function (done) {
    var params = {Bucket: buckets[0], Key: 'text', Body: 'Hello!'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should store a text object with some custom metadata', function (done) {
    var params = {
      Bucket: buckets[0], Key: 'textmetadata', Body: 'Hello!', Metadata: {
        someKey: 'value'
      }
    };
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should return a text object with some custom metadata', function (done) {
    s3Client.getObject({Bucket: buckets[0], Key: 'textmetadata'}, function (err, object) {
      if (err) {
        return done(err);
      }
      object.Metadata.somekey.should.equal('value');
      done();
    });
  });

  it('should store an image in a bucket', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      if (err) {
        return done(err);
      }
      var params = {
        Bucket: buckets[0],
        Key: 'image',
        Body: new Buffer(data),
        ContentType: 'image/jpeg',
        ContentLength: data.length
      };
      s3Client.putObject(params, function (err, data) {
        /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        done();
      });
    });
  });

  it('should store a gzip encoded file in bucket', function (done) {
    var file = path.join(__dirname, 'resources/jquery.js.gz');
    var stats = fs.statSync(file);

    var params = {
      Bucket: buckets[0],
      Key: 'jquery',
      Body: fs.createReadStream(file), // new Buffer(data),
      ContentType: 'application/javascript',
      ContentEncoding: 'gzip',
      ContentLength: stats.size
    };

    s3Client.putObject(params, function (err, data) {
      if (err) return done(err);

      s3Client.getObject({Bucket: buckets[0], Key: 'jquery'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ContentLength.should.equal(stats.size.toString());
        object.ContentEncoding.should.equal('gzip');
        object.ContentType.should.equal('application/javascript');
        done();
      });
    });
  });

  it('should copy an image object into another bucket', function (done) {
    var params = {
      Bucket: buckets[3],
      Key: 'image/jamie',
      CopySource: '/' + buckets[0] + '/image'
    };
    s3Client.copyObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should fail to copy an image object because the object does not exist', function (done) {
    var params = {
      Bucket: buckets[3],
      Key: 'image/jamie',
      CopySource: '/' + buckets[0] + '/doesnotexist'
    };
    s3Client.copyObject(params, function (err) {
      err.code.should.equal('NoSuchKey');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should fail to copy an image object because the source bucket does not exist', function (done) {
    var params = {
      Bucket: buckets[3],
      Key: 'image/jamie',
      CopySource: '/falsebucket/doesnotexist'
    };
    s3Client.copyObject(params, function (err) {
      err.code.should.equal('NoSuchBucket');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should store a large buffer in a bucket', function (done) {
    // 20M
    var b = new Buffer(20000000);
    var params = {Bucket: buckets[0], Key: 'large', Body: b};
    s3Client.putObject(params, function (err, data) {
      if (err) {
        return done(err);
      }
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      done();
    });
  });

  it('should get an image from a bucket', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ETag.should.equal(md5(data));
        object.ContentLength.should.equal(data.length.toString());
        object.ContentType.should.equal('image/jpeg');
        done();
      });
    });
  });

  it('should get image metadata from a bucket using HEAD method', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      s3Client.headObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ETag.should.equal(md5(data));
        object.ContentLength.should.equal(data.length.toString());
        object.ContentType.should.equal('image/jpeg');
        done();
      });
    });
  });

  it('should store a different image and update the previous image', function (done) {
    setTimeout(function () {
      async.waterfall([
          /**
           * Get object from store
           */
            function (callback) {
            s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
              if (err) {
                return callback(err);
              }
              callback(null, object);
            });
          },
          /**
           * Store different object
           */
            function (object, callback) {
            var file = path.join(__dirname, 'resources/image1.jpg');
            fs.readFile(file, function (err, data) {
              if (err) {
                return callback(err);
              }
              var params = {
                Bucket: buckets[0],
                Key: 'image',
                Body: new Buffer(data),
                ContentType: 'image/jpeg',
                ContentLength: data.length
              };
              s3Client.putObject(params, function (err, storedObject) {
                storedObject.ETag.should.not.equal(object.ETag);

                if (err) {
                  return callback(err);
                }
                callback(null, object);
              });
            });
          },
          /**
           * Get object again and do some comparisons
           */
            function (object, callback) {
            s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err, newObject) {
              if (err) {
                return callback(err);
              }
              newObject.LastModified.should.not.equal(object.LastModified);
              newObject.ContentLength.should.not.equal(object.ContentLength);
              callback(null);
            });
          }
        ],
        function (err) {
          if (err) {
            return done(err);
          }
          return done();
        });
    }, 1000);
  });

  it('should get an objects acl from a bucket', function (done) {
    s3Client.getObjectAcl({Bucket: buckets[0], Key: 'image'}, function (err, object) {
      if (err) {
        return done(err);
      }
      object.Owner.DisplayName.should.equal('S3rver');
      done();
    });
  });

  it('should delete an image from a bucket', function (done) {
    s3Client.deleteObject({Bucket: buckets[0], Key: 'image'}, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should not find an image from a bucket', function (done) {
    s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err) {
      err.code.should.equal('NoSuchKey');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should fail to delete a bucket because it is not empty', function (done) {
    s3Client.deleteBucket({Bucket: buckets[0]}, function (err) {
      err.code.should.equal('BucketNotEmpty');
      err.statusCode.should.equal(409);
      done();
    });
  });

  it('should upload a text file to a multi directory path', function (done) {
    var params = {Bucket: buckets[0], Key: 'multi/directory/path/text', Body: 'Hello!'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should find a text file in a multi directory path', function (done) {
    s3Client.getObject({Bucket: buckets[0], Key: 'multi/directory/path/text'}, function (err, object) {
      if (err) {
        return done(err);
      }
      object.ETag.should.equal(md5('Hello!'));
      object.ContentLength.should.equal('6');
      object.ContentType.should.equal('application/octet-stream');
      done();
    });
  });

  it('should list objects in a bucket', function (done) {
    // Create some test objects
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, function (err, object) {
        /[a-fA-F0-9]{32}/.test(object.ETag).should.equal(true);
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      s3Client.listObjects({'Bucket': buckets[1]}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(testObjects.length);
        done();
      });
    });
  });

  it('should list objects in a bucket filtered by a prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({'Bucket': buckets[1], Prefix: 'key'}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(4);
      should.exist(_.find(objects.Contents, {'Key': 'key1'}));
      should.exist(_.find(objects.Contents, {'Key': 'key2'}));
      should.exist(_.find(objects.Contents, {'Key': 'key3'}));
      should.exist(_.find(objects.Contents, {'Key': 'key/key1'}));
      done();
    });
  });

  it('should list objects in a bucket filtered by a marker', function (done) {

    // Create some test objects
    s3Client.listObjects({'Bucket': buckets[1], Marker: 'akey3'}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(5);
      done();
    });
  });

  it('should list objects in a bucket filtered by a marker and prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({'Bucket': buckets[1], Prefix: 'akey', Marker: 'akey2'}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(2);
      done();
    });
  });

  it('should list objects in a bucket filtered by a prefix and a delimiter', function (done) {
    s3Client.listObjects({'Bucket': buckets[1], Prefix: 'key', Delimiter: '/'}, function(err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(3);
      should.exist(_.find(objects.Contents, {'Key': 'key1'}));
      should.exist(_.find(objects.Contents, {'Key': 'key2'}));
      should.exist(_.find(objects.Contents, {'Key': 'key3'}));
      done();
    });
  });

  it('should list folders in a bucket filtered by a prefix and a delimiter', function (done) {
    s3Client.listObjects({'Bucket': buckets[1], Prefix: 'key', Delimiter: '/'}, function(err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.CommonPrefixes.length).equal(1);
      should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'key'}));
      done();
    });
  });

  it('should list no objects because of invalid prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({'Bucket': buckets[1], Prefix: 'myinvalidprefix'}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(0);
      done();
    });
  });

  it('should list no objects because of invalid marker', function (done) {
    // Create some test objects
    s3Client.listObjects({'Bucket': buckets[1], Marker: 'myinvalidmarker'}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(0);
      done();
    });
  });

  it('should generate a few thousand small objects', function (done) {
    var testObjects = [];
    for (var i = 1; i <= 2000; i++) {
      testObjects.push({Bucket: buckets[2], Key: 'key' + i, Body: 'Hello!'});
    }
    async.eachSeries(testObjects, function (testObject, callback) {
      s3Client.putObject(testObject, function (err, object) {
        /[a-fA-F0-9]{32}/.test(object.ETag).should.equal(true);
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should return one thousand small objects', function (done) {
    s3Client.listObjects({'Bucket': buckets[2]}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(1000);
      done();
    });
  });

  it('should return 500 small objects', function (done) {
    s3Client.listObjects({'Bucket': buckets[2], MaxKeys: 500}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(500);
      done();
    });
  });

  it('should delete 500 small objects', function (done) {
    var testObjects = [];
    for (var i = 1; i <= 500; i++) {
      testObjects.push({Bucket: buckets[2], Key: 'key' + i});
    }
    async.eachSeries(testObjects, function (testObject, callback) {
      s3Client.deleteObject(testObject, function (err) {
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });
});

describe('S3rver Tests with Static Web Hosting', function () {
  var s3Client;
  var s3rver;
  before(function (done) {
    s3rver = new S3rver({
      port: 5694,
      hostname: 'localhost',
      silent: true,
      indexDocument: 'index.html',
      errorDocument: '',
      directory: '/tmp/s3rver_test_directory'
    }).run(function (err, hostname, port, directory) {
        if (err) {
          return done('Error starting server', err);
        }
        var config = {
          accessKeyId: '123',
          secretAccessKey: 'abc',
          endpoint: util.format('%s:%d', hostname, port),
          sslEnabled: false,
          s3ForcePathStyle: true
        };
        AWS.config.update(config);
        s3Client = new AWS.S3();
        s3Client.endpoint = new AWS.Endpoint(config.endpoint);
        /**
         * Remove if exists and recreate the temporary directory
         */
        fs.remove(directory, function (err) {
          if (err) {
            return done(err);
          }
          fs.mkdirs(directory, function (err) {
            if (err) {
              return done(err);
            }
            done();
          });
        });
      });
  });

  after(function (done) {
    s3rver.close(done);
  });

  it('should create a site bucket', function (done) {
    s3Client.createBucket({Bucket: 'site'}, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should upload a html page to / path', function (done) {
    var params = {Bucket: 'site', Key: 'index.html', Body: '<html><body>Hello</body></html>'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should upload a html page to a directory path', function (done) {
    var params = {Bucket: 'site', Key: 'page/index.html', Body: '<html><body>Hello</body></html>'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should get an index page at / path', function (done) {
    request('http://localhost:5694/site/', function (error, response, body) {
      if (error) {
        return done(error);
      }

      if (response.statusCode !== 200) {
        return done(new Error('Invalid status: ' + response.statusCode));
      }

      if (body !== '<html><body>Hello</body></html>') {
        return done(new Error('Invalid Content: ' + body));
      }

      done();
    });
  });

  it('should get an index page at /page/ path', function (done) {
    request('http://localhost:5694/site/page/', function (error, response, body) {
      if (error) {
        return done(error);
      }

      if (response.statusCode !== 200) {
        return done(new Error('Invalid status: ' + response.statusCode));
      }

      if (body !== '<html><body>Hello</body></html>') {
        return done(new Error('Invalid Content: ' + body));
      }

      done();
    });
  });

  it('should get a 404 error page', function (done) {
    request('http://localhost:5694/site/page/not-exists', function (error, response) {
      if (error) {
        return done(error);
      }

      if (response.statusCode !== 404) {
        return done(new Error('Invalid status: ' + response.statusCode));
      }

      if (response.headers['content-type'] !== 'text/html; charset=utf-8') {
        return done(new Error('Invalid ContentType: ' + response.headers['content-type']));
      }

      done();
    });
  });

});
