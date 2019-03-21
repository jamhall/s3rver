"use strict";

const AWS = require("aws-sdk");
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
const fs = require("fs-extra");
const { find, times } = require("lodash");
const md5 = require("md5");
const moment = require("moment");
const os = require("os");
const path = require("path");
const promiseLimit = require("promise-limit");
const request = require("request-promise-native");
const { fromEvent } = require("rxjs");
const { take } = require("rxjs/operators");

const S3rver = require("..");
const { toISO8601String } = require("../lib/utils");

const { expect } = chai;
chai.use(chaiAsPromised);

const tmpDir = path.join(os.tmpdir(), "s3rver_test");
// Change the default options to be more test-friendly
S3rver.defaultOptions.port = 4569;
S3rver.defaultOptions.silent = true;
S3rver.defaultOptions.directory = tmpDir;

/**
 * Remove if exists and recreate the temporary directory
 *
 * Be aware of https://github.com/isaacs/rimraf/issues/25
 * Buckets can fail to delete on Windows likely due to a bug/shortcoming in Node.js
 */
function resetTmpDir() {
  try {
    fs.removeSync(tmpDir);
    // eslint-disable-next-line no-empty
  } catch (err) {}
  fs.ensureDirSync(tmpDir);
}

function generateTestObjects(s3Client, bucket, amount) {
  const objects = times(amount, i => ({
    Bucket: bucket,
    Key: "key" + i,
    Body: "Hello!"
  }));

  return promiseLimit(100).map(objects, object =>
    s3Client.putObject(object).promise()
  );
}

describe("S3rver Class Tests", function() {
  beforeEach("Reset buckets", resetTmpDir);

  it("should support running on port 0", async function() {
    const server = new S3rver({
      port: 0
    });
    const { port } = await server.run();
    await server.close();
    expect(port).to.be.above(0);
  });

  it("should create preconfigured buckets on startup", async function() {
    const buckets = [{ name: "bucket1" }, { name: "bucket2" }];
    const server = new S3rver({
      configureBuckets: buckets
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      const res = await s3Client.listBuckets().promise();
      expect(res.Buckets).to.have.lengthOf(2);
    } finally {
      await server.close();
    }
  });

  it("should create a preconfigured bucket with configs on startup", async function() {
    const bucket = {
      name: "bucket1",
      configs: [
        fs.readFileSync("./example/cors.xml"),
        fs.readFileSync("./example/website.xml")
      ]
    };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client.getBucketCors({ Bucket: bucket.name }).promise();
      await s3Client.getBucketWebsite({ Bucket: bucket.name }).promise();
    } catch (err) {
      throw err;
    } finally {
      await server.close();
    }
  });

  it("cleans up after close if the resetOnClose setting is true", async function() {
    const bucket = { name: "foobars" };

    const server = new S3rver({
      resetOnClose: true,
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await generateTestObjects(s3Client, bucket.name, 10);
    } finally {
      await server.close();
    }
    await expect(server.store.listBuckets()).to.eventually.have.lengthOf(0);
  });

  it("does not clean up after close if the resetOnClose setting is false", async function() {
    const bucket = { name: "foobars" };

    const server = new S3rver({
      resetOnClose: false,
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await generateTestObjects(s3Client, bucket.name, 10);
    } finally {
      await server.close();
    }
    await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
  });

  it("does not clean up after close if the resetOnClose setting is not set", async function() {
    const bucket = { name: "foobars" };

    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await generateTestObjects(s3Client, bucket.name, 10);
    } finally {
      await server.close();
    }
    await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
  });

  it("can delete a bucket that is empty after some key nested in a directory has been deleted", async function() {
    const bucket = { name: "foobars" };

    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: bucket.name,
          Key: "foo/bar/foo.txt",
          Body: "Hello!"
        })
        .promise();
      await s3Client
        .deleteObject({ Bucket: bucket.name, Key: "foo/bar/foo.txt" })
        .promise();
      await s3Client.deleteBucket({ Bucket: bucket.name }).promise();
    } finally {
      await server.close();
    }
  });

  it("can put an object in a bucket after all objects are deleted", async function() {
    const bucket = "foobars";

    const server = new S3rver();
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client.createBucket({ Bucket: bucket }).promise();
      await s3Client
        .putObject({ Bucket: bucket, Key: "foo.txt", Body: "Hello!" })
        .promise();
      await s3Client.deleteObject({ Bucket: bucket, Key: "foo.txt" }).promise();
      await s3Client
        .putObject({ Bucket: bucket, Key: "foo2.txt", Body: "Hello2!" })
        .promise();
    } finally {
      await server.close();
    }
  });
});

describe("S3rver Tests", function() {
  const buckets = [
    { name: "bucket1" },
    { name: "bucket2" },
    { name: "bucket3" },
    { name: "bucket4" },
    { name: "bucket5" },
    { name: "bucket6" }
  ];
  let server;
  let s3Client;

  beforeEach("Reset buckets", resetTmpDir);
  beforeEach("Start server and create buckets", async function() {
    server = new S3rver({
      configureBuckets: buckets
    });
    const { port } = await server.run();

    s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
  });

  afterEach("Close server", function(done) {
    server.close(done);
  });

  it("should fetch six buckets", async function() {
    const buckets = await s3Client.listBuckets().promise();
    expect(buckets.Buckets).to.have.lengthOf(6);
    for (const bucket of buckets.Buckets) {
      expect(bucket.Name).to.exist;
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  it("should create a bucket with valid domain-style name", async function() {
    await s3Client.createBucket({ Bucket: "a-test.example.com" }).promise();
  });

  it("should fail to create a bucket because of invalid name", async function() {
    let error;
    try {
      await s3Client.createBucket({ Bucket: "-$%!nvalid" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because of invalid domain-style name", async function() {
    let error;
    try {
      await s3Client.createBucket({ Bucket: ".example.com" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because name is too long", async function() {
    let error;
    try {
      await s3Client.createBucket({ Bucket: "abcd".repeat(16) }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because name is too short", async function() {
    let error;
    try {
      await s3Client.createBucket({ Bucket: "ab" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should delete a bucket", async function() {
    await s3Client.deleteBucket({ Bucket: buckets[4].name }).promise();
  });

  it("should delete a bucket configured with CORS", async function() {
    await s3Client
      .putBucketCors({
        Bucket: buckets[0].name,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ["*"],
              AllowedMethods: ["GET", "HEAD"]
            }
          ]
        }
      })
      .promise();
    await s3Client.deleteBucket({ Bucket: buckets[0].name }).promise();
  });

  it("should fail to delete a bucket because it is not empty", async function() {
    let error;
    await generateTestObjects(s3Client, buckets[0].name, 20);
    try {
      await s3Client.deleteBucket({ Bucket: buckets[0].name }).promise();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.code).to.equal("BucketNotEmpty");
    expect(error.statusCode).to.equal(409);
  });

  it("should not fetch the deleted bucket", async function() {
    let error;
    await s3Client.deleteBucket({ Bucket: buckets[4].name }).promise();
    try {
      await s3Client.listObjects({ Bucket: buckets[4].name }).promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchBucket");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should list no objects for a bucket", async function() {
    await s3Client.listObjects({ Bucket: buckets[3].name }).promise();
    const objects = await s3Client
      .listObjects({ Bucket: buckets[3].name })
      .promise();
    expect(objects.Contents).to.have.lengthOf(0);
  });

  it("should store a text object in a bucket", async function() {
    const data = await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "text", Body: "Hello!" })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should store a text object with no content type and retrieve it", async function() {
    const res = await request({
      method: "PUT",
      baseUrl: s3Client.config.endpoint,
      url: `/${buckets[0].name}/text`,
      body: "Hello!",
      resolveWithFullResponse: true
    });
    expect(res.statusCode).to.equal(200);
    const data = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "text" })
      .promise();
    expect(data.ContentType).to.equal("binary/octet-stream");
  });

  it("should store a text object with some custom metadata", async function() {
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "textmetadata",
        Body: "Hello!",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const object = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "textmetadata" })
      .promise();
    expect(object.Metadata.somekey).to.equal("value");
  });

  it("should store an image in a bucket", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should store a gzip encoded file in bucket", async function() {
    const file = path.join(__dirname, "resources/jquery.js.gz");

    const params = {
      Bucket: buckets[0].name,
      Key: "jquery",
      Body: await fs.readFile(file),
      ContentType: "application/javascript",
      ContentEncoding: "gzip"
    };

    await s3Client.putObject(params).promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "jquery" })
      .promise();
    expect(object.ContentEncoding).to.equal("gzip");
    expect(object.ContentType).to.equal("application/javascript");
  });

  it("should distinguish keys stored with and without a trailing /", async function() {
    await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "text", Body: "Hello!" })
      .promise();
    await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "text/", Body: "Goodbye!" })
      .promise();
    const obj1 = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "text" })
      .promise();
    const obj2 = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "text/" })
      .promise();
    expect(obj1.Body.toString()).to.equal("Hello!");
    expect(obj2.Body.toString()).to.equal("Goodbye!");
  });

  it("should copy an image object into another bucket", async function() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: srcKey,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const copyResult = await s3Client
      .copyObject({
        Bucket: buckets[3].name,
        Key: destKey,
        CopySource: "/" + buckets[0].name + "/" + srcKey
      })
      .promise();
    expect(copyResult.ETag).to.equal(data.ETag);
    expect(moment(copyResult.LastModified).isValid()).to.be.true;
  });

  it("should copy an image object into another bucket including its metadata", async function() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: srcKey,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    await s3Client
      .copyObject({
        Bucket: buckets[3].name,
        Key: destKey,
        // MetadataDirective is implied to be COPY
        CopySource: "/" + buckets[0].name + "/" + srcKey
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[3].name, Key: destKey })
      .promise();
    expect(object.Metadata).to.have.property("somekey", "value");
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should copy an object using spaces/unicode chars in keys", async function() {
    const srcKey = "awesome 驚くばかり.jpg";
    const destKey = "new 新しい.jpg";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: srcKey,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const copyResult = await s3Client
      .copyObject({
        Bucket: buckets[0].name,
        Key: destKey,
        CopySource: "/" + buckets[0].name + "/" + encodeURI(srcKey)
      })
      .promise();
    expect(copyResult.ETag).to.equal(data.ETag);
    expect(moment(copyResult.LastModified).isValid()).to.be.true;
  });

  it("should update the metadata of an image object", async function() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: srcKey,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    await s3Client
      .copyObject({
        Bucket: buckets[3].name,
        Key: destKey,
        CopySource: "/" + buckets[0].name + "/" + srcKey,
        MetadataDirective: "REPLACE",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[3].name, Key: destKey })
      .promise();
    expect(object.Metadata).to.have.property("somekey", "value");
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should copy an image object into another bucket and update its metadata", async function() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: srcKey,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    await s3Client
      .copyObject({
        Bucket: buckets[3].name,
        Key: destKey,
        CopySource: "/" + buckets[0].name + "/" + srcKey,
        MetadataDirective: "REPLACE",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[3].name, Key: destKey })
      .promise();
    expect(object.Metadata.somekey).to.equal("value");
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should fail to copy an image object because the object does not exist", async function() {
    let error;
    try {
      await s3Client
        .copyObject({
          Bucket: buckets[3].name,
          Key: "image/jamie",
          CopySource: "/" + buckets[0].name + "/doesnotexist"
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should fail to copy an image object because the source bucket does not exist", async function() {
    let error;
    try {
      await s3Client
        .copyObject({
          Bucket: buckets[3].name,
          Key: "image/jamie",
          CopySource: "/falsebucket/doesnotexist"
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchBucket");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should fail to update the metadata of an image object when no REPLACE MetadataDirective is specified", async function() {
    const key = "image";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: key,
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    let error;
    try {
      await s3Client
        .copyObject({
          Bucket: buckets[0].name,
          Key: key,
          CopySource: "/" + buckets[0].name + "/" + key,
          Metadata: {
            someKey: "value"
          }
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
    }
    expect(error).to.exist;
  });

  it("should store a large buffer in a bucket", async function() {
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "large",
        Body: Buffer.alloc(20 * Math.pow(1024, 2))
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should get an image from a bucket", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const data = await fs.readFile(file);
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: data,
        ContentType: "image/jpeg"
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "image" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5(data)));
    expect(object.ContentLength).to.equal(data.length);
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should get partial image from a bucket with a range request", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });
    const res = await request({
      url,
      headers: { range: "bytes=0-99" },
      resolveWithFullResponse: true
    });
    expect(res.statusCode).to.equal(206);
    expect(res.headers).to.have.property("content-range");
    expect(res.headers).to.have.property("accept-ranges");
    expect(res.headers).to.have.property("content-length", "100");
  });

  it("should return 416 error for out of bounds range requests", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const filesize = fs.statSync(file).size;
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });

    let error;
    try {
      await request({
        url,
        headers: { range: `bytes=${filesize + 100}-${filesize + 200}` },
        resolveWithFullResponse: true
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(416);
  });

  it("partial out of bounds range requests should return actual length of returned data", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const filesize = fs.statSync(file).size;
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });
    const res = await request({
      url,
      headers: { range: "bytes=0-100000" },
      resolveWithFullResponse: true
    });
    expect(res.statusCode).to.equal(206);
    expect(res.headers).to.have.property("content-range");
    expect(res.headers).to.have.property("accept-ranges");
    expect(res.headers).to.have.property("content-length", filesize.toString());
  });

  it("should get image metadata from a bucket using HEAD method", async function() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const fileContent = await fs.readFile(file);
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: fileContent,
        ContentType: "image/jpeg",
        ContentLength: fileContent.length
      })
      .promise();
    const object = await s3Client
      .headObject({ Bucket: buckets[0].name, Key: "image" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5(fileContent)));
    expect(object.ContentLength).to.equal(fileContent.length);
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should store a different image and update the previous image", async function() {
    const files = [
      path.join(__dirname, "resources/image0.jpg"),
      path.join(__dirname, "resources/image1.jpg")
    ];

    // Get object from store
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(files[0]),
        ContentType: "image/jpeg"
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "image" })
      .promise();

    // Store different object
    const storedObject = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile(files[1]),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(storedObject.ETag).to.not.equal(object.ETag);

    // Get object again and do some comparisons
    const newObject = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "image" })
      .promise();
    expect(newObject.LastModified).to.not.equal(object.LastModified);
    expect(newObject.ContentLength).to.not.equal(object.ContentLength);
  });

  it("should get an objects acl from a bucket", async function() {
    const object = await s3Client
      .getObjectAcl({ Bucket: buckets[0].name, Key: "image0" })
      .promise();
    expect(object.Owner.DisplayName).to.equal("S3rver");
  });

  it("should delete an image from a bucket", async function() {
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "large",
        Body: Buffer.alloc(10)
      })
      .promise();
    await s3Client
      .deleteObject({ Bucket: buckets[0].name, Key: "large" })
      .promise();
  });

  it("should not find an image from a bucket", async function() {
    let error;
    try {
      await s3Client
        .getObject({ Bucket: buckets[0].name, Key: "image" })
        .promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should not fail to delete a nonexistent object from a bucket", async function() {
    await s3Client
      .deleteObject({ Bucket: buckets[0].name, Key: "doesnotexist" })
      .promise();
  });

  it("should upload a text file to a multi directory path", async function() {
    const data = await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/text",
        Body: "Hello!"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should complete a managed upload <=5MB", async function() {
    const data = await s3Client
      .upload({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/multipart",
        Body: Buffer.alloc(2 * Math.pow(1024, 2)) // 2MB
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should complete a managed upload >5MB (multipart upload)", async function() {
    const data = await s3Client
      .upload({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/multipart",
        Body: Buffer.alloc(20 * Math.pow(1024, 2)) // 20MB
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should complete a multipart upload with metadata", async function() {
    const data = await s3Client
      .upload({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/multipart",
        Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const object = await s3Client
      .getObject({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/multipart"
      })
      .promise();
    expect(object.Metadata.somekey).to.equal("value");
  });

  it("should find a text file in a multi directory path", async function() {
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "multi/directory/path/text",
        Body: "Hello!"
      })
      .promise();
    const object = await s3Client
      .getObject({ Bucket: buckets[0].name, Key: "multi/directory/path/text" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5("Hello!")));
    expect(object.ContentLength).to.equal(6);
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should list objects in a bucket", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    // Create some test objects
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = await s3Client
      .listObjects({ Bucket: buckets[1].name })
      .promise();
    expect(data.Name).to.equal(buckets[1].name);
    expect(data.Contents).to.have.lengthOf(testObjects.length);
    expect(data.IsTruncated).to.be.false;
  });

  it("should list objects in a bucket filtered by a prefix", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    // Create some test objects
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );

    const data = await s3Client
      .listObjects({ Bucket: buckets[1].name, Prefix: "key" })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
    expect(find(data.Contents, { Key: "akey1" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey2" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey3" })).to.not.exist;
  });

  it("should list objects in a bucket filtered by a prefix [v2]", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = await s3Client
      .listObjectsV2({ Bucket: buckets[1].name, Prefix: "key" })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
    expect(find(data.Contents, { Key: "akey1" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey2" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey3" })).to.not.exist;
  });

  it("should list objects in a bucket filtered by a marker", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = await s3Client
      .listObjects({
        Bucket: buckets[1].name,
        Marker: "akey3"
      })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
  });

  it("should list objects in a bucket filtered by a marker and prefix", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = await s3Client
      .listObjects({ Bucket: buckets[1].name, Prefix: "akey", Marker: "akey2" })
      .promise();
    expect(data.Contents).to.have.lengthOf(1);
  });

  it("should list objects in a bucket filtered by a delimiter", async function() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = await s3Client
      .listObjects({ Bucket: buckets[1].name, Delimiter: "/" })
      .promise();
    expect(data.Contents).to.have.lengthOf(6);
    expect(find(data.CommonPrefixes, { Prefix: "key/" })).to.exist;
  });

  it("should list folders in a bucket filtered by a prefix and a delimiter", async function() {
    const testObjects = [
      "folder1/file1.txt",
      "folder1/file2.txt",
      "folder1/folder2/file3.txt",
      "folder1/folder2/file4.txt",
      "folder1/folder2/file5.txt",
      "folder1/folder2/file6.txt",
      "folder1/folder4/file7.txt",
      "folder1/folder4/file8.txt",
      "folder1/folder4/folder5/file9.txt",
      "folder1/folder3/file10.txt"
    ];

    await Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[5].name, Key: key, Body: "Hello!" })
          .promise()
      )
    );

    const data = await s3Client
      .listObjects({
        Bucket: buckets[5].name,
        Prefix: "folder1/",
        Delimiter: "/"
      })
      .promise();
    expect(data.CommonPrefixes).to.have.lengthOf(3);
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder2/" })).to.exist;
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder3/" })).to.exist;
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder4/" })).to.exist;
  });

  it("should list no objects because of invalid prefix", async function() {
    const data = await s3Client
      .listObjects({ Bucket: buckets[1].name, Prefix: "myinvalidprefix" })
      .promise();
    expect(data.Contents).to.have.lengthOf(0);
  });

  it("should list no objects because of invalid marker", async function() {
    const data = await s3Client
      .listObjects({
        Bucket: buckets[1].name,
        Marker: "myinvalidmarker"
      })
      .promise();
    expect(data.Contents).to.have.lengthOf(0);
  });

  it("should generate a few thousand small objects", async function() {
    this.timeout(30000);
    const data = await generateTestObjects(s3Client, buckets[2].name, 2000);
    for (const object of data) {
      expect(object.ETag).to.match(/[a-fA-F0-9]{32}/);
    }
  });

  it("should return one thousand small objects", async function() {
    this.timeout(30000);
    await generateTestObjects(s3Client, buckets[2].name, 2000);
    const data = await s3Client
      .listObjects({ Bucket: buckets[2].name })
      .promise();
    expect(data.IsTruncated).to.be.true;
    expect(data.Contents).to.have.lengthOf(1000);
  });

  it("should return 500 small objects", async function() {
    this.timeout(30000);
    await generateTestObjects(s3Client, buckets[2].name, 1000);
    const data = await s3Client
      .listObjects({ Bucket: buckets[2].name, MaxKeys: 500 })
      .promise();
    expect(data.IsTruncated).to.be.true;
    expect(data.Contents).to.have.lengthOf(500);
  });

  it("should delete 500 small objects", async function() {
    this.timeout(30000);
    await generateTestObjects(s3Client, buckets[2].name, 500);
    await promiseLimit(100).map(times(500), i =>
      s3Client
        .deleteObject({ Bucket: buckets[2].name, Key: "key" + i })
        .promise()
    );
  });

  it("should delete 500 small objects with deleteObjects", async function() {
    this.timeout(30000);
    await generateTestObjects(s3Client, buckets[2].name, 500);
    const deleteObj = { Objects: times(500, i => ({ Key: "key" + i })) };
    const data = await s3Client
      .deleteObjects({ Bucket: buckets[2].name, Delete: deleteObj })
      .promise();
    expect(data.Deleted).to.exist;
    expect(data.Deleted).to.have.lengthOf(500);
    expect(find(data.Deleted, { Key: "key67" })).to.exist;
  });

  it("should report invalid XML when using deleteObjects with zero objects", async function() {
    let error;
    try {
      await s3Client
        .deleteObjects({ Bucket: buckets[2].name, Delete: { Objects: [] } })
        .promise();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.code).to.equal("MalformedXML");
  });

  it("should return nonexistent objects as deleted with deleteObjects", async function() {
    const deleteObj = { Objects: [{ Key: "doesnotexist" }] };
    const data = await s3Client
      .deleteObjects({ Bucket: buckets[2].name, Delete: deleteObj })
      .promise();
    expect(data.Deleted).to.exist;
    expect(data.Deleted).to.have.lengthOf(1);
    expect(find(data.Deleted, { Key: "doesnotexist" })).to.exist;
  });

  it("should reach the server with a bucket vhost", async function() {
    const body = await request({
      url: s3Client.endpoint.href,
      headers: { host: buckets[0].name + ".s3.amazonaws.com" },
      json: true
    });
    expect(body).to.include("ListBucketResult");
  });
});

describe("Authenticated Request Tests", function() {
  const buckets = [{ name: "bucket1" }, { name: "bucket2" }];
  let server;

  beforeEach("Reset buckets", resetTmpDir);
  beforeEach("Start server and create buckets", async function() {
    server = new S3rver({
      configureBuckets: buckets
    });
    await server.run();
  });

  afterEach("Close server", function(done) {
    server.close(done);
  });

  it("should reject a request specifying multiple auth mechanisms", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        qs: {
          "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
          Signature: "dummysig"
        },
        headers: {
          Authorization: "AWS S3RVER:dummysig"
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(400);
    expect(error.response.body).to.contain("<Code>InvalidArgument</Code>");
  });

  it("should reject a request with an invalid authorization header [v2]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        headers: {
          Authorization: "AWS S3RVER dummysig"
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(400);
    expect(error.response.body).to.contain("<Code>InvalidArgument</Code>");
  });

  it("should reject a request with an invalid authorization header [v4]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        headers: {
          // omitting Signature and SignedHeaders components
          Authorization:
            "AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request",
          "X-Amz-Content-SHA256": "UNSIGNED-PAYLOAD"
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(400);
    expect(error.response.body).to.contain(
      "<Code>AuthorizationHeaderMalformed</Code>"
    );
  });

  it("should reject a request with invalid query params [v2]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        qs: {
          AWSAccessKeyId: "S3RVER",
          Signature: "dummysig"
          // expiration is omitted
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain("<Code>AccessDenied</Code>");
  });

  it("should reject a request with invalid query params [v4]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        qs: {
          "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
          "X-Amz-Signature": "dummysig"
          // omitting most other parameters for sig v4
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(400);
    expect(error.response.body).to.contain(
      "<Code>AuthorizationQueryParametersError</Code>"
    );
  });

  it("should reject a request with an incorrect signature in header [v2]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        headers: {
          Authorization: "AWS S3RVER:badsig",
          "X-Amz-Date": new Date().toUTCString()
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain(
      "<Code>SignatureDoesNotMatch</Code>"
    );
  });

  it("should reject a request with an incorrect signature in query params [v2]", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        qs: {
          AWSAccessKeyId: "S3RVER",
          Signature: "badsig",
          Expires: (Date.now() / 1000).toFixed() + 900
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain(
      "<Code>SignatureDoesNotMatch</Code>"
    );
  });

  it("should reject a request with a large time skew", async function() {
    const { port } = server.httpServer.address();
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        headers: {
          Authorization: "AWS S3RVER:dummysig",
          // 20 minutes in the future
          "X-Amz-Date": new Date(Date.now() + 20000 * 60).toUTCString()
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain("<Code>RequestTimeTooSkewed</Code>");
  });

  it("should reject an expired presigned request [v2]", async function() {
    const { port } = server.httpServer.address();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true,
      signatureVersion: "v2"
    });

    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "mykey",
      Expires: -10 // 10 seconds in the past
    });
    let error;
    try {
      await request(url);
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain("<Code>AccessDenied</Code>");
  });

  it("should reject an expired presigned request [v4]", async function() {
    const { port } = server.httpServer.address();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true,
      signatureVersion: "v4"
    });

    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "mykey"
    });
    let error;
    try {
      await request({
        url
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain("<Code>AccessDenied</Code>");
  });

  it("should reject a presigned request with an invalid expiration [v4]", async function() {
    const { port } = server.httpServer.address();
    // aws-sdk unfortunately doesn't expose a way to set the timestamp of the request to presign
    // so we have to construct a mostly-valid request ourselves
    let error;
    try {
      await request({
        baseUrl: `http://localhost:${port}`,
        uri: `${buckets[0].name}/mykey`,
        qs: {
          "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
          "X-Amz-Credential": "S3RVER/20060301/us-east-1/s3/aws4_request",
          "X-Amz-SignedHeaders": "host",
          "X-Amz-Signature": "dummysig",
          // 10 minutes in the past
          "X-Amz-Date": toISO8601String(Date.now() - 20000 * 60),
          "X-Amz-Expires": 20
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
    expect(error.response.body).to.contain("<Code>AccessDenied</Code>");
  });

  it("should override response headers in signed GET requests", async function() {
    const { port } = server.httpServer.address();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile("./test/resources/image0.jpg")
      })
      .promise();
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image",
      ResponseContentType: "image/jpeg",
      ResponseContentDisposition: "attachment"
    });
    const res = await request({
      url,
      resolveWithFullResponse: true
    });
    expect(res.headers["content-type"]).to.equal("image/jpeg");
    expect(res.headers["content-disposition"]).to.equal("attachment");
  });

  it("should reject anonymous requests with response header overrides in GET requests", async function() {
    const { port } = server.httpServer.address();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });

    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "image",
        Body: await fs.readFile("./test/resources/image0.jpg")
      })
      .promise();
    let error;
    try {
      await request({
        baseUrl: s3Client.config.endpoint,
        uri: `${buckets[0].name}/image`,
        qs: {
          "response-content-type": "image/jpeg"
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(400);
    expect(error.response.body).to.contain("<Code>InvalidRequest</Code>");
  });

  it("should add x-amz-meta-* metadata specified via query parameters", async function() {
    const { port } = server.httpServer.address();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const url = s3Client.getSignedUrl("putObject", {
      Bucket: buckets[0].name,
      Key: "mykey",
      Metadata: {
        somekey: "value"
      }
    });
    await request({
      method: "PUT",
      url,
      body: "Hello!"
    });
    const object = await s3Client
      .headObject({
        Bucket: buckets[0].name,
        Key: "mykey"
      })
      .promise();
    expect(object.Metadata).to.have.property("somekey", "value");
  });
});

describe("S3 Event Notification Tests", function() {
  const buckets = [{ name: "bucket1" }, { name: "bucket2" }];
  let server;
  let s3Client;

  beforeEach("Reset buckets", resetTmpDir);
  beforeEach("Start server and create buckets", async function() {
    server = new S3rver({
      configureBuckets: buckets
    });
    const { port } = await server.run();

    s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
  });

  afterEach("Close server", function(done) {
    server.close(done);
  });

  it("should trigger an event with a valid message structure", async function() {
    const eventPromise = fromEvent(server, "event")
      .pipe(take(1))
      .toPromise();
    const body = "Hello!";
    await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "testPutKey", Body: body })
      .promise();
    const event = await eventPromise;
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(event.Records[0].eventTime).to.match(iso8601);
    expect(new Date(event.Records[0].eventTime)).to.not.satisfy(isNaN);
  });

  it("should trigger a Put event", async function() {
    const eventPromise = fromEvent(server, "event")
      .pipe(take(1))
      .toPromise();
    const body = "Hello!";
    await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "testPutKey", Body: body })
      .promise();
    const event = await eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectCreated:Put");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[0].name);
    expect(event.Records[0].s3.object).to.contain({
      key: "testPutKey",
      size: body.length,
      eTag: md5(body)
    });
  });

  it("should trigger a Copy event", async function() {
    const body = "Hello!";
    await s3Client
      .putObject({ Bucket: buckets[0].name, Key: "testPut", Body: body })
      .promise();
    const eventPromise = fromEvent(server, "event")
      .pipe(take(1))
      .toPromise();
    await s3Client
      .copyObject({
        Bucket: buckets[1].name,
        Key: "testCopy",
        CopySource: "/" + buckets[0].name + "/testPut"
      })
      .promise();
    const event = await eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectCreated:Copy");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[1].name);
    expect(event.Records[0].s3.object).to.contain({
      key: "testCopy",
      size: body.length
    });
  });

  it("should trigger a Delete event", async function() {
    const body = "Hello!";
    await s3Client
      .putObject({
        Bucket: buckets[0].name,
        Key: "testDelete",
        Body: body
      })
      .promise();
    const eventPromise = fromEvent(server, "event")
      .pipe(take(1))
      .toPromise();
    await s3Client
      .deleteObject({ Bucket: buckets[0].name, Key: "testDelete" })
      .promise();
    const event = await eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectRemoved:Delete");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[0].name);
    expect(event.Records[0].s3.object).to.contain({
      key: "testDelete"
    });
  });
});

describe("CORS Policy Tests", function() {
  beforeEach("Reset buckets", resetTmpDir);

  const buckets = [
    // provides rules for origins http://a-test.example.com and http://*.bar.com
    {
      name: "bucket0",
      configs: [fs.readFileSync("./test/resources/cors_test0.xml")]
    }
  ];

  it("should fail to initialize a configuration with multiple wildcard characters", async function() {
    let error;
    try {
      const server = new S3rver({
        configureBuckets: [
          {
            name: "bucket0",
            configs: [fs.readFileSync("./test/resources/cors_invalid0.xml")]
          }
        ]
      });
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include(" can not have more than one wildcard.");
  });

  it("should fail to initialize a configuration with an illegal AllowedMethod", async function() {
    const server = new S3rver({
      configureBuckets: [
        {
          name: "bucket1",
          configs: [fs.readFileSync("./test/resources/cors_invalid1.xml")]
        }
      ]
    });
    let error;
    try {
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include(
      "Found unsupported HTTP method in CORS config."
    );
  });

  it("should fail to initialize a configuration with missing required fields", async function() {
    const server = new S3rver({
      configureBuckets: [
        {
          name: "bucket2",
          configs: [fs.readFileSync("./test/resources/cors_invalid2.xml")]
        }
      ]
    });
    let error;
    try {
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.code).to.equal("MalformedXML");
  });

  it("should put a CORS configuration in an unconfigured bucket", async function() {
    const bucket = { name: "cors-put" };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putBucketCors({
          Bucket: bucket.name,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ["*"],
                AllowedMethods: ["GET", "HEAD"]
              }
            ]
          }
        })
        .promise();
      await s3Client.getBucketCors({ Bucket: bucket.name }).promise();
    } finally {
      await server.close();
    }
  });

  it("should delete a CORS configuration in an configured bucket", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      await s3Client.deleteBucketCors({ Bucket: buckets[0].name }).promise();
      await s3Client.getBucketCors({ Bucket: buckets[0].name }).promise();
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.code).to.equal("NoSuchCORSConfiguration");
  });

  it("should add the Access-Control-Allow-Origin header for a wildcard origin", async function() {
    const origin = "http://a-test.example.com";
    const bucket = {
      name: "foobars",
      configs: [fs.readFileSync("./example/cors.xml")]
    };

    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: bucket.name,
          Key: "image",
          Body: await fs.readFile("./test/resources/image0.jpg"),
          ContentType: "image/jpeg"
        })
        .promise();
      const url = s3Client.getSignedUrl("getObject", {
        Bucket: bucket.name,
        Key: "image"
      });
      const res = await request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property("access-control-allow-origin", "*");
    } finally {
      await server.close();
    }
  });

  it("should add the Access-Control-Allow-Origin header for a matching origin", async function() {
    const origin = "http://a-test.example.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "image",
          Body: await fs.readFile("./test/resources/image0.jpg"),
          ContentType: "image/jpeg"
        })
        .promise();
      const url = s3Client.getSignedUrl("getObject", {
        Bucket: buckets[0].name,
        Key: "image"
      });
      const res = await request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property(
        "access-control-allow-origin",
        origin
      );
    } finally {
      await server.close();
    }
  });

  it("should match an origin to a CORSRule with a wildcard character", async function() {
    const origin = "http://foo.bar.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "image",
          Body: await fs.readFile("./test/resources/image0.jpg"),
          ContentType: "image/jpeg"
        })
        .promise();
      const url = s3Client.getSignedUrl("getObject", {
        Bucket: buckets[0].name,
        Key: "image"
      });
      const res = await request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property(
        "access-control-allow-origin",
        origin
      );
    } finally {
      await server.close();
    }
  });

  it("should not add the Access-Control-Allow-Origin header for a non-matching origin", async function() {
    const origin = "http://b-test.example.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "image",
          Body: await fs.readFile("./test/resources/image0.jpg"),
          ContentType: "image/jpeg"
        })
        .promise();
      const url = s3Client.getSignedUrl("getObject", {
        Bucket: buckets[0].name,
        Key: "image"
      });
      const res = await request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.not.have.property("access-control-allow-origin");
    } finally {
      await server.close();
    }
  });

  it("should expose appropriate headers for a range request", async function() {
    const origin = "http://a-test.example.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "image",
          Body: await fs.readFile("./test/resources/image0.jpg"),
          ContentType: "image/jpeg"
        })
        .promise();
      const url = s3Client.getSignedUrl("getObject", {
        Bucket: buckets[0].name,
        Key: "image"
      });
      const res = await request({
        url,
        headers: { origin, range: "bytes=0-99" },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(206);
      expect(res.headers).to.have.property(
        "access-control-expose-headers",
        "Accept-Ranges, Content-Range"
      );
    } finally {
      await server.close();
    }
  });

  it("should respond to OPTIONS requests with allowed headers", async function() {
    const origin = "http://foo.bar.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });
    try {
      const res = await request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Range, Authorization"
        },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property("access-control-allow-origin", "*");
      expect(res.headers).to.have.property(
        "access-control-allow-headers",
        "range, authorization"
      );
    } finally {
      await server.close();
    }
  });

  it("should respond to OPTIONS requests with a Forbidden response", async function() {
    const origin = "http://a-test.example.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });
    let error;
    try {
      await request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Range, Authorization"
        }
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
  });

  it("should respond to OPTIONS requests with a Forbidden response when CORS is disabled", async function() {
    const origin = "http://foo.bar.com";
    const bucket = { name: "foobar" };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: bucket.name,
      Key: "image"
    });
    let error;
    try {
      await request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET"
        },
        resolveWithFullResponse: true
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(403);
  });

  it("should respond correctly to OPTIONS requests that dont specify access-control-request-headers", async function() {
    const origin = "http://a-test.example.com";
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0].name,
      Key: "image"
    });
    try {
      await request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET"
          // No Access-Control-Request-Headers specified...
        }
      });
    } finally {
      await server.close();
    }
  });
});

describe("Static Website Tests", function() {
  const buckets = [
    // A standard static hosting configuration with no custom error page
    {
      name: "site",
      configs: [fs.readFileSync("./test/resources/website_test0.xml")]
    }
  ];

  beforeEach("Reset buckets", resetTmpDir);

  it("should put a website configuration in an unconfigured bucket", async function() {
    const bucket = { name: "website-put" };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      await s3Client
        .putBucketWebsite({
          Bucket: bucket.name,
          WebsiteConfiguration: {
            IndexDocument: {
              Suffix: "index.html"
            }
          }
        })
        .promise();
      await s3Client.getBucketWebsite({ Bucket: bucket.name }).promise();
    } finally {
      await server.close();
    }
  });

  it("should delete a website configuration in an configured bucket", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      await s3Client.deleteBucketWebsite({ Bucket: buckets[0].name }).promise();
      await s3Client.getBucketWebsite({ Bucket: buckets[0].name }).promise();
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.code).to.equal("NoSuchWebsiteConfiguration");
  });

  it("should fail to read an object at the website endpoint from a bucket with no website configuration", async function() {
    const bucket = { name: "bucket1" };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      await s3Client
        .putObject({
          Bucket: bucket.name,
          Key: "page/index.html",
          Body: "<html><body>Hello</body></html>"
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: "page/",
        headers: { host: `${bucket.name}.s3-website-us-east-1.amazonaws.com` }
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(404);
    expect(error.response.headers).to.have.property(
      "content-type",
      "text/html; charset=utf-8"
    );
    expect(error.response.body).to.contain("Code: NoSuchWebsiteConfiguration");
  });

  it("should get an index page at / path", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const expectedBody = "<html><body>Hello</body></html>";
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "index.html",
          Body: expectedBody
        })
        .promise();
      const body = await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/`,
        headers: { accept: "text/html" }
      });
      expect(body).to.equal(expectedBody);
    } finally {
      await server.close();
    }
  });

  it("should get an index page at /page/ path", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const expectedBody = "<html><body>Hello</body></html>";
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "page/index.html",
          Body: expectedBody
        })
        .promise();
      const body = await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page/`,
        headers: { accept: "text/html" }
      });
      expect(body).to.equal(expectedBody);
    } finally {
      await server.close();
    }
  });

  it("should not get an index page at /page/ path if an object is stored there", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const indexBody = "<html><body>Hello</body></html>";
    const expectedBody = "<html><body>Goodbye</body></html>";
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "page/index.html",
          Body: indexBody
        })
        .promise();
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "page/",
          Body: expectedBody
        })
        .promise();

      const body = await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page/`,
        headers: { accept: "text/html" }
      });
      expect(body).to.equal(expectedBody);
    } finally {
      await server.close();
    }
  });

  it("should get a 302 redirect at /page path", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      const body = "<html><body>Hello</body></html>";
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "page/index.html",
          Body: body
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page`,
        headers: { accept: "text/html" },
        followRedirect: false
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(302);
    expect(error.response.headers).to.have.property(
      "location",
      `/${buckets[0].name}/page/`
    );
  });

  it("should get a 302 redirect at /page path for vhost-style bucket", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const body = "<html><body>Hello</body></html>";
    let error;
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "page/index.html",
          Body: body
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: "page",
        headers: {
          host: `${buckets[0].name}.s3-website-us-east-1.amazonaws.com`
        },
        followRedirect: false
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(302);
    expect(error.response.headers).to.have.property("location", "/page/");
  });

  it("should get a HTML 404 error page", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page/not-exists`,
        headers: { accept: "text/html" }
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(404);
    expect(error.response.headers).to.have.property(
      "content-type",
      "text/html; charset=utf-8"
    );
  });

  it("should serve a custom error page if it exists", async function() {
    const bucket = {
      name: "site",
      configs: [fs.readFileSync("./example/website.xml")]
    };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const body = "<html><body>Oops!</body></html>";
    let error;
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "error.html",
          Body: body,
          ContentType: "text/html"
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page/not-exists`,
        headers: { accept: "text/html" }
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.response.headers).to.have.property(
      "content-type",
      "text/html; charset=utf-8"
    );
    expect(error.response.body).to.equal(body);
  });

  it("should return a XML error document for SDK requests", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    let error;
    try {
      await s3Client
        .getObject({
          Bucket: buckets[0].name,
          Key: "page/not-exists"
        })
        .promise();
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(404);
    expect(error.code).to.equal("NoSuchKey");
  });

  it("should store an object with website-redirect-location metadata", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      const redirectLocation = "https://github.com/jamhall/s3rver";
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "index.html",
          Body: "<html><body>Hello</body></html>",
          WebsiteRedirectLocation: redirectLocation
        })
        .promise();
      const res = await s3Client
        .getObject({
          Bucket: buckets[0].name,
          Key: "index.html"
        })
        .promise();
      expect(res).to.have.property("WebsiteRedirectLocation", redirectLocation);
    } finally {
      await server.close();
    }
  });

  it("should redirect for an object stored with a website-redirect-location", async function() {
    const server = new S3rver({
      configureBuckets: [buckets[0]]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const redirectLocation = "https://github.com/jamhall/s3rver";
    let error;
    try {
      await s3Client
        .putObject({
          Bucket: buckets[0].name,
          Key: "index.html",
          Body: "<html><body>Hello</body></html>",
          WebsiteRedirectLocation: redirectLocation
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/`,
        headers: { accept: "text/html" },
        followRedirect: false
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(301);
    expect(error.response.headers).to.have.property(
      "location",
      redirectLocation
    );
  });

  it("should redirect for a custom error page stored with a website-redirect-location", async function() {
    const bucket = {
      name: "site",
      configs: [fs.readFileSync("./example/website.xml")]
    };
    const server = new S3rver({
      configureBuckets: [bucket]
    });
    const { port } = await server.run();
    const s3Client = new AWS.S3({
      accessKeyId: "S3RVER",
      secretAccessKey: "S3RVER",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    const redirectLocation = "https://github.com/jamhall/s3rver";
    let error;
    try {
      const body = "<html><body>Hello</body></html>";
      await s3Client
        .putObject({
          Bucket: bucket.name,
          Key: "error.html",
          Body: body,
          WebsiteRedirectLocation: redirectLocation
        })
        .promise();
      await request({
        baseUrl: s3Client.endpoint.href,
        uri: `${buckets[0].name}/page/`,
        headers: { accept: "text/html" },
        followRedirect: false
      });
    } catch (err) {
      error = err;
    } finally {
      await server.close();
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(301);
    expect(error.response.headers).to.have.property(
      "location",
      redirectLocation
    );
  });
});
