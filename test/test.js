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
var md5 = require('md5');
var S3rver = require('../lib');
var util = require('util');
var request = require('request');

function recreateDirectory(path) {
  try {
    fs.removeSync(path);
  } catch (err) {}
  fs.ensureDirSync(path);
}

function generateTestObjects(s3Client, bucket, amount, callback) {
  var testObjects = _.times(amount, function (i) {
    return {
      Bucket: bucket,
      Key: 'key' + i,
      Body: 'Hello!'
    }
  });
  async.eachSeries(testObjects, function (testObject, callback) {
    s3Client.putObject(testObject, callback);
  }, callback)
}

describe('S3rver Tests', function () {
  var s3Client;
  var buckets = ['bucket1', 'bucket2', 'bucket3', 'bucket4', 'bucket5', 'bucket6'];
  var s3rver;

  beforeEach(function (done) {
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
        recreateDirectory(directory);
        // Create 6 buckets
        async.eachSeries(buckets, function (bucket, callback) {
          s3Client.createBucket({Bucket: bucket}, callback);
        }, done);
      });
  });

  afterEach(function (done) {
    s3rver.close(() => {
      process.removeAllListeners('uncaughtException');
      done();
    });
  });

  it('should fetch fetch six buckets', function (done) {
    s3Client.listBuckets(function (err, buckets) {
      if (err) {
        return done(err);
      }
      buckets.Buckets.length.should.equal(6);
      _.forEach(buckets.Buckets, function (bucket) {
        should.exist(bucket.Name);
        moment(bucket.CreationDate).isValid().should.equal(true);
      });
      done();
    });
  });

  it('should create a bucket with valid domain-style name', function (done) {
    s3Client.createBucket({Bucket: 'a-test.example.com'}, function (err) {
      should.not.exist(err);
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

  it('should fail to create a bucket because of invalid domain-style name', function (done) {
    s3Client.createBucket({Bucket: '.example.com'}, function (err) {
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
    s3Client.deleteBucket({Bucket: buckets[4]}, function (err) {
      if (err) {
        return done(err);
      }
      s3Client.listObjects({Bucket: buckets[4]}, function (err) {
        err.code.should.equal('NoSuchBucket');
        err.statusCode.should.equal(404);
        done();        
      })
    })
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
      /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
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
      /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should return a text object with some custom metadata', function (done) {
    var params = {
      Bucket: buckets[0], Key: 'textmetadata', Body: 'Hello!', Metadata: {
        someKey: 'value'
      }
    };
    s3Client.putObject(params, function (err, data) {
      /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      s3Client.getObject({Bucket: buckets[0], Key: 'textmetadata'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.Metadata.somekey.should.equal('value');
        done();
      });
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
        /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
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
        object.ContentLength.should.equal(stats.size);
        object.ContentEncoding.should.equal('gzip');
        object.ContentType.should.equal('application/javascript');
        done();
      });
    });
  });

  it('should copy an image object into another bucket', function (done) {
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
        /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        var params = {
          Bucket: buckets[3],
          Key: 'image/jamie',
          CopySource: '/' + buckets[0] + '/image'
        };
        s3Client.copyObject(params, function (err, data) {
          if (err) {
            return done(err);
          }
          /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
          moment(data.LastModified).isValid().should.equal(true);
          done();
        });
      });
    });
  });

  it('should update the metadata of an image object', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      if (err) {
        return done(err);
      }
      var params = {
        Bucket: buckets[0],
        Key: 'image/jamie',
        Body: new Buffer(data),
        ContentType: 'image/jpeg',
        ContentLength: data.length
      };
      s3Client.putObject(params, function (err, data) {
        /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        var key = 'image/jamie';
        var params = {
          Bucket: buckets[3],
          Key: key,
          CopySource: '/' + buckets[0] + '/' +  key,
          Metadata: {
            someKey: 'value'
          }
        };
        s3Client.copyObject(params, function (err, data) {
          if (err) {
            return done(err);
          }
          s3Client.getObject({Bucket: buckets[3], Key: key}, function (err, object) {
            if (err) {
              return done(err);
            }
            object.Metadata.somekey.should.equal('value');
            object.ContentType.should.equal('image/jpeg');
            done();
          });
        });
      })
    })
  });

  it('should copy an image object into another bucket and update its metadata', function (done) {
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
      s3Client.putObject(params, function () {
        var key = 'image/jamie';
        var params = {
          Bucket: buckets[3],
          Key: key,
          CopySource: '/' + buckets[0] + '/image',
          MetadataDirective: 'REPLACE',
          Metadata: {
            someKey: 'value'
          }
        };
        s3Client.copyObject(params, function () {
          s3Client.getObject({Bucket: buckets[3], Key: key}, function (err, object) {
            if (err) {
              return done(err);
            }
            object.Metadata.somekey.should.equal('value');
            object.ContentType.should.equal('image/jpeg');
            done();
          });
        });
      });
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
      /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
      done();
    });
  });

  it('should get an image from a bucket', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      var params = {
        Bucket: buckets[0],
        Key: 'image',
        Body: data,
        ContentType: 'image/jpeg',
        ContentLength: data.length,
      };
      s3Client.putObject(params, function (err) {
        s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
          if (err) {
            return done(err);
          }
          object.ETag.should.equal('"' + md5(data) + '"');
          object.ContentLength.should.equal(data.length);
          object.ContentType.should.equal('image/jpeg');
          done();
        });
      });
    });
  });

  it('should get image metadata from a bucket using HEAD method', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      var params = {
        Bucket: buckets[0],
        Key: 'image',
        Body: data,
        ContentType: 'image/jpeg',
        ContentLength: data.length,
      };
      s3Client.putObject(params, function (err) {
        s3Client.headObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
          if (err) {
            return done(err);
          }
          object.ETag.should.equal('"' + md5(data) + '"');
          object.ContentLength.should.equal(data.length);
          object.ContentType.should.equal('image/jpeg');
          done();
        });
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
              var file = path.join(__dirname, 'resources/image.jpg');
              fs.readFile(file, function (err, data) {
                var params = {
                  Bucket: buckets[0],
                  Key: 'image',
                  Body: data,
                  ContentType: 'image/jpeg',
                  ContentLength: data.length,
                };
                s3Client.putObject(params, function () {
                  s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err, object) {
                    if (err) {
                      return callback(err);
                    }
                    callback(null, object);
                  });
                });
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
    var b = new Buffer(10);
    var params = {Bucket: buckets[0], Key: 'large', Body: b};
    s3Client.putObject(params, function (err, data) {
      s3Client.deleteObject({Bucket: buckets[0], Key: 'image'}, done);
    })
  });

  it('should not find an image from a bucket', function (done) {
    s3Client.getObject({Bucket: buckets[0], Key: 'image'}, function (err) {
      err.code.should.equal('NoSuchKey');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should not fail to delete a nonexistent object from a bucket', function (done) {
    s3Client.deleteObject({Bucket: buckets[0], Key: 'doesnotexist'}, done);
  });

  it('should fail to delete a bucket because it is not empty', function (done) {
    generateTestObjects(s3Client, buckets[0], 20, function () {
      s3Client.deleteBucket({Bucket: buckets[0]}, function (err) {
        err.code.should.equal('BucketNotEmpty');
        err.statusCode.should.equal(409);
        done();
      });
    });
  });

  it('should upload a text file to a multi directory path', function (done) {
    var params = {Bucket: buckets[0], Key: 'multi/directory/path/text', Body: 'Hello!'};
    s3Client.putObject(params, function (err, data) {
      /"[a-fA-F0-9]{32}"/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should upload a managed upload <=5MB', function (done) {
    var params = { Bucket: buckets[0], Key: 'multi/directory/path/multipart', Body: Buffer.alloc(5e+6) }; // 5MB
    s3Client.upload(params, function (err, data) {
      (/"[a-fA-F0-9]{32}"/).test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should upload a managed upload >5MB (multipart upload)', function (done) {
    var params = { Bucket: buckets[0], Key: 'multi/directory/path/multipart', Body: Buffer.alloc(2e+7) }; // 20MB
    s3Client.upload(params, function (err, data) {
      (/"[a-fA-F0-9]{32}"/).test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should find a text file in a multi directory path', function (done) {
    var params = {Bucket: buckets[0], Key: 'multi/directory/path/text', Body: 'Hello!'};
    s3Client.putObject(params, function () {
      s3Client.getObject({Bucket: buckets[0], Key: 'multi/directory/path/text'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ETag.should.equal('"' + md5('Hello!') + '"');
        object.ContentLength.should.equal(6);
        object.ContentType.should.equal('application/octet-stream');
        done();
      });
    });
  });

  it('should list objects in a bucket', function (done) {
    // Create some test objects
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, function (err, object) {
        /[a-fA-F0-9]{32}/.test(object.ETag).should.equal(true);
        callback(err);
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
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, callback);
    }, function () {
      // Create some test objects
      s3Client.listObjects({'Bucket': buckets[1], Prefix: 'key'}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(4);
        should.not.exist(_.find(objects.Contents, {'Key': 'akey1'}));
        should.not.exist(_.find(objects.Contents, {'Key': 'akey2'}));
        should.not.exist(_.find(objects.Contents, {'Key': 'akey3'}));
        done();
      });
    });
  });


  it('should list objects in a bucket filtered by a prefix 2', function (done) {
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, callback);
    }, function () {
      s3Client.listObjectsV2({ 'Bucket': buckets[1], Prefix: 'key' }, function (err, objects) {
        if (err) {
          return done(err)
        }
        should(objects.Contents.length).equal(4);
        should.not.exist(_.find(objects.Contents, {'Key': 'akey1'}));
        should.not.exist(_.find(objects.Contents, {'Key': 'akey2'}));
        should.not.exist(_.find(objects.Contents, {'Key': 'akey3'}));
        done();
      });
    });
  })


  it('should list objects in a bucket filtered by a marker', function (done) {
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, callback);
    }, function () {
      s3Client.listObjects({'Bucket': buckets[1], Marker: 'akey3'}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(4);
        done();
      });
    });
  });

  it('should list objects in a bucket filtered by a marker and prefix', function (done) {
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, callback);
    }, function () {
      s3Client.listObjects({'Bucket': buckets[1], Prefix: 'akey', Marker: 'akey2'}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(1);
        done();
      });
    });
  });

  it('should list objects in a bucket filtered by a delimiter', function (done) {
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, callback);
    }, function () {
      s3Client.listObjects({'Bucket': buckets[1], Delimiter: '/'}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(6);
        should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'key/'}));
        done();
      });
    });
  });

  it('should list folders in a bucket filtered by a prefix and a delimiter', function (done) {
    var testObjects = [
      {Bucket: buckets[5], Key: "folder1/file1.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/file2.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder2/file3.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder2/file4.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder2/file5.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder2/file6.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder4/file7.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder4/file8.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder4/folder5/file9.txt", Body: 'Hello!'},
      {Bucket: buckets[5], Key: "folder1/folder3/file10.txt", Body: 'Hello!'}
    ];

    async.eachSeries(testObjects, function (testObject, callback) {
      s3Client.putObject(testObject, callback);
    }, function (err) {
      if (err) {
        return done(err);
      }
      s3Client.listObjects({'Bucket': buckets[5], Prefix: 'folder1/', Delimiter: '/'}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.CommonPrefixes.length).equal(4);
        should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'folder1/folder2/'}));
        should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'folder1/folder3/'}));
        should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'folder1/folder4/'}));
        should.exist(_.find(objects.CommonPrefixes, {'Prefix': 'folder1/folder4/folder5/'}));
        done();
      });
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
    this.timeout(0);    
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
    }, done);
  });

  it('should return one thousand small objects', function (done) {
    this.timeout(0);
    generateTestObjects(s3Client, buckets[2], 2000, function () {
      s3Client.listObjects({'Bucket': buckets[2]}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(1000);
        done();
      });
    });
  });

  it('should return 500 small objects', function (done) {
    this.timeout(0);    
    generateTestObjects(s3Client, buckets[2], 1000, function () {
      s3Client.listObjects({'Bucket': buckets[2], MaxKeys: 500}, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(500);
        done();
      });
    });
  });

  it('should delete 500 small objects', function (done) {
    this.timeout(0);        
    generateTestObjects(s3Client, buckets[2], 500, function () {
      var testObjects = [];
      for (var i = 1; i <= 500; i++) {
        testObjects.push({Bucket: buckets[2], Key: 'key' + i});
      }
      async.eachSeries(testObjects, function (testObject, callback) {
        s3Client.deleteObject(testObject, callback);
      }, done);
    });
  });

  it('should delete 500 small objects with deleteObjects', function (done) {
    this.timeout(0);    
    generateTestObjects(s3Client, buckets[2], 500, function () {
      var deleteObj = {Objects: []};
      for (var i = 501; i <= 1000; i++) {
        deleteObj.Objects.push({Key: 'key' + i});
      }
      s3Client.deleteObjects({Bucket: buckets[2], Delete: deleteObj}, function (err, resp) {
        if (err) {
          return done(err);
        }
        should.exist(resp.Deleted);
        should(resp.Deleted).have.length(500);
        should(resp.Deleted).containEql({Key: 'key567'});
        done();
      });
    });
  });

  it('should return nonexistent objects as deleted with deleteObjects', function (done) {
    var deleteObj = {Objects: [{Key: 'doesnotexist'}]};
    s3Client.deleteObjects({Bucket: buckets[2], Delete: deleteObj}, function (err, resp) {
      if (err) {
        return done(err);
      }
      should.exist(resp.Deleted);
      should(resp.Deleted).have.length(1);
      should(resp.Deleted).containEql({Key: 'doesnotexist'});
      done();
    });
  });

  it('should reach the server with a bucket vhost', function (done) {
    request({ url: 'http://localhost:4569/', headers: { host: buckets[0] + '.s3.amazonaws.com' } }, function (err, response, body) {
      if (err) {
        return done(err);
      }

      if (response.statusCode !== 200) {
        return done(new Error('Invalid status: ' + response.statusCode));
      }

      if (body.indexOf('ListBucketResult') === -1) {
        return done(new Error('Unexpected response: ' + body));
      }

      done();
    });
  });
});

describe('S3rver Tests with Static Web Hosting', function () {
  var s3Client;
  var s3rver;
  beforeEach(function (done) {
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
          fs.mkdirs(directory, done);
        });
      });
  });

  afterEach(function (done) {
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
    s3Client.createBucket({Bucket: 'site'}, function () {
      var params = {Bucket: 'site', Key: 'index.html', Body: '<html><body>Hello</body></html>'};
      s3Client.putObject(params, function (err, data) {
        if (err) return done(err);
        /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        done();
      });
    });
  });

  it('should upload a html page to a directory path', function (done) {
    s3Client.createBucket({Bucket: 'site'}, function () {
      var params = {Bucket: 'site', Key: 'page/index.html', Body: '<html><body>Hello</body></html>'};
      s3Client.putObject(params, function (err, data) {
        /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        done();
      });
    });
  });

  it('should get an index page at / path', function (done) {
    s3Client.createBucket({Bucket: 'site'}, function () {
      var params = {Bucket: 'site', Key: 'index.html', Body: '<html><body>Hello</body></html>'};
      s3Client.putObject(params, function (err, data) {
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
    });
  });

  it('should get an index page at /page/ path', function (done) {
    s3Client.createBucket({Bucket: 'site'}, function () {
      var params = {Bucket: 'site', Key: 'page/index.html', Body: '<html><body>Hello</body></html>'};
      s3Client.putObject(params, function () {
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
    });
  });

  it('should get a 404 error page', function (done) {
    s3Client.createBucket({Bucket: 'site'}, function () {
      request('http://localhost:5694/site/page/not-exists', function (error, response) {
        if (error) {
          return done(error);
        }

        if (response.statusCode !== 404) {
          return done(new Error('Invalid status: ' + response.statusCode));
        }

        if (response.headers['content-type'] !== 'text/html') {
          return done(new Error('Invalid ContentType: ' + response.headers['content-type']));
        }

        done();
      });
    });
  });
});

it('Cleans up after close if the removeBucketsOnClose setting is true', function (done) {
  var directory = '/tmp/s3rver_test_directory';
  recreateDirectory(directory);
  var s3rver = new S3rver({
    port: 4569,
    hostname: 'localhost',
    silent: true,
    indexDocument: '',
    errorDocument: '',
    directory: directory,
    removeBucketsOnClose: true
  }).run(function () {
    var config = {
      accessKeyId: '123',
      secretAccessKey: 'abc',
      endpoint: util.format('%s:%d', 'localhost', 4569),
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    var s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    s3Client.createBucket({Bucket: 'foobars'}, function (err) {
      if (err) return done(err);
      generateTestObjects(s3Client, 'foobars', 10, function (err) {
        if (err) return done(err);
        s3rver.close(function (err) {
          if (err) return done(err);
          var exists = fs.existsSync(directory);
          should(exists).equal(true);
          var files = fs.readdirSync(directory);
          should(files.length).equal(0)
          done();
        });
      });
    });
  });
});

it('Does not clean up after close if the removeBucketsOnClose setting is false', function (done) {
  var directory = '/tmp/s3rver_test_directory';
  recreateDirectory(directory);
  var s3rver = new S3rver({
    port: 4569,
    hostname: 'localhost',
    silent: true,
    indexDocument: '',
    errorDocument: '',
    directory: directory,
    removeBucketsOnClose: false
  }).run(function () {
    var config = {
      accessKeyId: '123',
      secretAccessKey: 'abc',
      endpoint: util.format('%s:%d', 'localhost', 4569),
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    var s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    s3Client.createBucket({Bucket: 'foobars'}, function (err) {
      if (err) return done(err);
      generateTestObjects(s3Client, 'foobars', 10, function (err) {
        if (err) return done(err);
        s3rver.close(function (err) {
          if (err) return done(err);
          var exists = fs.existsSync(directory);
          should(exists).equal(true);
          var files = fs.readdirSync(directory);
          should(files.length).equal(1)
          done();
        });
      });
    });
  });
});

it('Does not clean up after close if the removeBucketsOnClose setting is not set', function (done) {
  var directory = '/tmp/s3rver_test_directory';
  recreateDirectory(directory);
  var s3rver = new S3rver({
    port: 4569,
    hostname: 'localhost',
    silent: true,
    indexDocument: '',
    errorDocument: '',
    directory: directory
  }).run(function () {
    var config = {
      accessKeyId: '123',
      secretAccessKey: 'abc',
      endpoint: util.format('%s:%d', 'localhost', 4569),
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    var s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    s3Client.createBucket({Bucket: 'foobars'}, function (err) {
      if (err) return done(err);
      generateTestObjects(s3Client, 'foobars', 10, function (err) {
        if (err) return done(err);
        s3rver.close(function (err) {
          if (err) return done(err);
          var exists = fs.existsSync(directory);
          should(exists).equal(true);
          var files = fs.readdirSync(directory);
          should(files.length).equal(1)
          done();
        });
      });
    });
  });
});

it('Can delete a bucket that is empty after some key that includes a directory has been deleted', function (done) {
  var directory = '/tmp/s3rver_test_directory';
  recreateDirectory(directory);
  var s3rver = new S3rver({
    port: 4569,
    hostname: 'localhost',
    silent: true,
    indexDocument: '',
    errorDocument: '',
    directory: directory,
  }).run(function () {
    var config = {
      accessKeyId: '123',
      secretAccessKey: 'abc',
      endpoint: util.format('%s:%d', 'localhost', 4569),
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    var s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    var bucket = 'foobars';

    s3Client.createBucket({Bucket: bucket}).promise()
      .then(() => s3Client.putObject({ Bucket: bucket, Key: 'foo/foo.txt', Body: 'Hello!'}).promise())
      .then(() => s3Client.deleteObject({ Bucket: bucket, Key: 'foo/foo.txt' }).promise())
      .then(() => s3Client.deleteBucket({ Bucket: bucket }).promise())
      .then(() => s3rver.close(done))
      .catch(err => s3rver.close(() => done(err)));
  });
});

describe('S3rver Class Tests', function() {

  it('should merge default options with provided options', function () {
    var s3rver = new S3rver({
      hostname: 'testhost',
      indexDocument: 'index.html',
      errorDocument: '',
      directory: '/tmp/s3rver_test_directory',
      key: new Buffer([1, 2, 3]),
      cert: new Buffer([1, 2, 3]),
      removeBucketsOnClose: true
    })

    s3rver.options.should.have.property('hostname', 'testhost')
    s3rver.options.should.have.property('port', 4578)
    s3rver.options.should.have.property('silent', false)
    s3rver.options.should.have.property('indexDocument', 'index.html')
    s3rver.options.should.have.property('errorDocument', '')
    s3rver.options.should.have.property('directory', '/tmp/s3rver_test_directory')
    s3rver.options.should.have.property('key')
    s3rver.options.should.have.property('cert')
    s3rver.options.key.should.be.an.instanceOf(Buffer)
    s3rver.options.cert.should.be.an.instanceOf(Buffer)
    s3rver.options.should.have.property('removeBucketsOnClose', true)
  })

});
