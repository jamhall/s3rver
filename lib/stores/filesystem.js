"use strict";

const crypto = require("crypto");
const fs = require("fs-extra");
const { pick, pickBy, sortBy, zip } = require("lodash");
const path = require("path");
const { format } = require("util");

const S3Bucket = require("../models/bucket");
const S3Object = require("../models/object");
const { concatStreams, walk } = require("../utils");

const S3RVER_SUFFIX = "._S3rver_%s";

class FilesystemStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  // helpers

  getBucketPath(bucketName) {
    return path.join(this.rootDirectory, bucketName);
  }

  async retrieveMetadata(bucket, key) {
    const contentPath = path.join(
      this.getBucketPath(bucket),
      key,
      format(S3RVER_SUFFIX, "object")
    );

    // this is expected to throw if the object doesn't exist
    const stat = await fs.stat(contentPath);
    const [storedMetadata, md5] = await Promise.all([
      fs
        .readFile(`${contentPath}.json`)
        .then(JSON.parse)
        .catch(err => {
          if (err.code === "ENOENT") return undefined;
          throw err;
        }),
      fs
        .readFile(`${contentPath}.md5`)
        .then(md5 => md5.toString())
        .catch(async err => {
          if (err.code !== "ENOENT") throw err;
          // create the md5 file if it doesn't already exist
          const md5 = await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(contentPath);
            const md5Context = crypto.createHash("md5");
            stream.on("error", reject);
            stream.on("data", chunk => md5Context.update(chunk, "utf8"));
            stream.on("end", () => resolve(md5Context.digest("hex")));
          });
          await fs.writeFile(`${contentPath}.md5`, md5);
          return md5;
        })
    ]);

    return {
      ...storedMetadata,
      etag: JSON.stringify(md5),
      "last-modified": stat.mtime.toUTCString(),
      "content-length": stat.size
    };
  }

  async storeMetadata(bucket, key, metadata, md5) {
    const contentPath = path.join(
      this.getBucketPath(bucket),
      key,
      format(S3RVER_SUFFIX, "object")
    );

    const json = {
      ...pick(metadata, [
        "cache-control",
        "content-disposition",
        "content-encoding",
        "content-language",
        "content-type",
        "expires",
        "website-redirect-location"
      ]),
      ...pickBy(metadata, (value, key) => key.startsWith("x-amz-meta-"))
    };

    if (md5) await fs.writeFile(`${contentPath}.md5`, md5);
    await fs.writeFile(`${contentPath}.json`, JSON.stringify(json, null, 4));
  }

  // store implementation

  reset() {
    const list = fs.readdirSync(this.rootDirectory);
    for (const file of list) {
      fs.removeSync(path.join(this.rootDirectory, file));
    }
  }

  async getBuckets() {
    const list = await fs.readdir(this.rootDirectory);
    const buckets = await Promise.all(
      list.map(filename => this.getBucket(filename))
    );
    return buckets.filter(Boolean);
  }

  async getBucket(bucket) {
    const bucketPath = this.getBucketPath(bucket);
    try {
      const stat = await fs.stat(bucketPath);
      if (!stat.isDirectory()) return null;
      return new S3Bucket(bucket, stat.birthtime);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async putBucket(bucket) {
    const bucketPath = this.getBucketPath(bucket);
    await fs.mkdirp(bucketPath, 0o0755);
    return this.getBucket(bucket);
  }

  async deleteBucket(bucket) {
    return fs.rmdir(this.getBucketPath(bucket));
  }

  async listObjects(bucket, options) {
    const bucketPath = this.getBucketPath(bucket);
    const commonPrefixes = new Set();
    let keys = walk(bucketPath).map(key => key.slice(bucketPath.length + 1));

    if (!keys.length) {
      return {
        objects: [],
        commonPrefixes: [],
        isTruncated: false
      };
    }

    if (options.prefix) {
      keys = keys.filter(key => key.startsWith(options.prefix));
    }

    if (options.delimiter) {
      const prefix = options.prefix || "";
      keys = keys.filter(key => {
        const idx = key.slice(prefix.length).indexOf(options.delimiter);
        if (idx === -1) return true;
        // Add to common prefixes before we filter this key out
        commonPrefixes.add(key.slice(0, prefix.length + idx + 1));
        return false;
      });
    }

    keys.sort();
    if (options.marker) {
      keys = keys.slice(
        keys.findIndex(key => key.startsWith(options.marker)) + 1
      );
    }

    const metadataArr = await Promise.all(
      keys.map(key =>
        this.retrieveMetadata(bucket, key).catch(err => {
          if (err.code === "ENOENT") return undefined;
          throw err;
        })
      )
    );
    const objects = zip(keys, metadataArr)
      .filter(([, metadata]) => !!metadata)
      .map(([key, metadata]) => new S3Object(bucket, key, null, metadata));

    return {
      objects: objects.slice(0, options.maxKeys),
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated: objects.length > options.maxKeys
    };
  }

  async existsObject(bucket, key) {
    const objFile = path.join(
      this.getBucketPath(bucket),
      key,
      format(S3RVER_SUFFIX, "object")
    );
    try {
      await fs.stat(objFile);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  async getObject(bucket, key, options) {
    const dirName = path.join(this.getBucketPath(bucket), key);
    try {
      const metadata = await this.retrieveMetadata(bucket, key);
      const lastByte = Number(metadata["content-length"]) - 1;
      const range = {
        start: (options && options.start) || 0,
        end: Math.min((options && options.end) || Infinity, lastByte)
      };

      if (range.start < 0 || Math.min(range.end, lastByte) < range.start) {
        // the range is not satisfiable
        const object = new S3Object(bucket, key, null, metadata);
        if (options && (options.start || options.end)) {
          object.range = range;
        }
        return object;
      }

      const content = await new Promise((resolve, reject) => {
        const stream = fs
          .createReadStream(
            path.join(dirName, format(S3RVER_SUFFIX, "object")),
            range
          )
          .on("error", reject)
          .on("open", () => resolve(stream));
      });
      const object = new S3Object(bucket, key, content, metadata);
      if (options && (options.start || options.end)) {
        object.range = range;
      }
      return object;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async putObject(object) {
    const dirName = path.join(this.getBucketPath(object.bucket), object.key);

    await fs.mkdirp(dirName);

    const [size, md5] = await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(
        path.join(dirName, format(S3RVER_SUFFIX, "object"))
      );
      const md5Context = crypto.createHash("md5");
      let totalLength = 0;

      object.content
        .on("data", chunk => {
          writeStream.write(chunk, "binary");
          md5Context.update(chunk, "binary");
          totalLength += chunk.length;
        })
        .on("error", reject)
        .on("end", () => {
          writeStream.end();
          resolve([totalLength, md5Context.digest("hex")]);
        });
    });
    await this.storeMetadata(object.bucket, object.key, object.metadata, md5);
    return { size, md5 };
  }

  async copyObject(
    srcBucket,
    srcKey,
    destBucket,
    destKey,
    replacementMetadata
  ) {
    const srcKeyPath = path.join(this.getBucketPath(srcBucket), srcKey);
    const destKeyPath = path.join(this.getBucketPath(destBucket), destKey);
    const srcContentPath = path.join(
      srcKeyPath,
      format(S3RVER_SUFFIX, "object")
    );
    const destContentPath = path.join(
      destKeyPath,
      format(S3RVER_SUFFIX, "object")
    );

    if (srcKeyPath !== destKeyPath) {
      await fs.mkdirp(destKeyPath);
      await fs.copy(srcContentPath, destContentPath);
    }

    if (replacementMetadata) {
      await this.storeMetadata(destBucket, destKey, replacementMetadata);
      return this.retrieveMetadata(destBucket, destKey);
    } else {
      if (srcKeyPath !== destKeyPath) {
        await fs.copy(`${srcContentPath}.json`, `${destContentPath}.json`);
      }
      return this.retrieveMetadata(destBucket, destKey);
    }
  }

  async deleteObject(bucket, key) {
    const bucketPath = this.getBucketPath(bucket);
    const keyPath = path.join(bucketPath, key);
    await Promise.all(
      [
        path.join(keyPath, format(S3RVER_SUFFIX, "object")),
        path.join(keyPath, format(S3RVER_SUFFIX, "object.md5")),
        path.join(keyPath, format(S3RVER_SUFFIX, "object.json"))
      ].map(filePath =>
        fs.unlink(filePath).catch(err => {
          if (err.code !== "ENOENT") throw err;
        })
      )
    );
    // clean up empty directories
    const parts = key.split("/");
    while (
      parts.length &&
      !fs.readdirSync(path.join(bucketPath, ...parts)).length
    ) {
      await fs.rmdir(path.join(bucketPath, ...parts));
      parts.pop();
    }
  }

  async putObjectMultipart(bucket, key, uploadId, parts, metadata) {
    const partPaths = sortBy(parts, part => part.number).map(part =>
      path.join(this.getBucketPath(bucket), uploadId + "_" + part.number)
    );
    const partStreams = partPaths.map(partPath => {
      const stream = fs.createReadStream(
        path.join(partPath, format(S3RVER_SUFFIX, "object"))
      );
      stream.on("close", err => !err && fs.removeSync(partPath));
      return stream;
    });
    const object = new S3Object(
      bucket,
      key,
      concatStreams(partStreams),
      metadata
    );
    return this.putObject(object);
  }
}

module.exports = FilesystemStore;
