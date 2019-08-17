'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const { pick, pickBy, sortBy, zip } = require('lodash');
const md5File = require('md5-file');
const path = require('path');
const { format } = require('util');

const { getConfigModel } = require('../models/config');
const S3Bucket = require('../models/bucket');
const S3Object = require('../models/object');
const { concatStreams, walk } = require('../utils');

const S3RVER_SUFFIX = '%s._S3rver_%s';

class FilesystemStore {
  static decodeKeyPath(keyPath) {
    return process.platform === 'win32'
      ? keyPath.replace(/&../g, ent =>
          Buffer.from(ent.slice(1), 'hex').toString(),
        )
      : keyPath;
  }

  static encodeKeyPath(key) {
    return process.platform === 'win32'
      ? key.replace(
          /[<>:"\\|?*]/g,
          ch => '&' + Buffer.from(ch, 'utf8').toString('hex'),
        )
      : key;
  }

  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  // helpers

  getBucketPath(bucketName) {
    return path.join(this.rootDirectory, bucketName);
  }

  getResourcePath(bucket, key = '', resource) {
    const parts = FilesystemStore.encodeKeyPath(key).split('/');
    const suffix = format(S3RVER_SUFFIX, parts.pop(), resource);
    return path.join(this.rootDirectory, bucket, ...parts, suffix);
  }

  async getMetadata(bucket, key) {
    const objectPath = this.getResourcePath(bucket, key, 'object');
    const metadataPath = this.getResourcePath(bucket, key, 'metadata.json');

    // this is expected to throw if the object doesn't exist
    const stat = await fs.stat(objectPath);
    const [storedMetadata, md5] = await Promise.all([
      fs
        .readFile(metadataPath)
        .then(JSON.parse)
        .catch(err => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        }),
      fs
        .readFile(`${objectPath}.md5`)
        .then(md5 => md5.toString())
        .catch(async err => {
          if (err.code !== 'ENOENT') throw err;
          // create the md5 file if it doesn't already exist
          const md5 = await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(objectPath);
            const md5Context = crypto.createHash('md5');
            stream.on('error', reject);
            stream.on('data', chunk => md5Context.update(chunk, 'utf8'));
            stream.on('end', () => resolve(md5Context.digest('hex')));
          });
          await fs.writeFile(`${objectPath}.md5`, md5);
          return md5;
        }),
    ]);

    return {
      ...storedMetadata,
      etag: JSON.stringify(md5),
      'last-modified': stat.mtime.toUTCString(),
      'content-length': stat.size,
    };
  }

  async putMetadata(bucket, key, metadata, md5) {
    const metadataPath = this.getResourcePath(bucket, key, 'metadata.json');
    const md5Path = this.getResourcePath(bucket, key, 'object.md5');

    const json = {
      ...pick(metadata, S3Object.ALLOWED_METADATA),
      ...pickBy(metadata, (value, key) => key.startsWith('x-amz-meta-')),
    };

    if (md5) await fs.writeFile(md5Path, md5);
    await fs.writeFile(metadataPath, JSON.stringify(json, null, 2));
  }

  // store implementation

  reset() {
    const list = fs.readdirSync(this.rootDirectory);
    for (const file of list) {
      fs.removeSync(path.join(this.rootDirectory, file));
    }
  }

  async listBuckets() {
    const list = await fs.readdir(this.rootDirectory);
    const buckets = await Promise.all(
      list.map(filename => this.getBucket(filename)),
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
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putBucket(bucket) {
    const bucketPath = this.getBucketPath(bucket);
    await fs.mkdirp(bucketPath, 0o0755);
    return this.getBucket(bucket);
  }

  async deleteBucket(bucket) {
    return fs.remove(this.getBucketPath(bucket));
  }

  async listObjects(bucket, options) {
    const {
      delimiter = '',
      startAfter = '',
      prefix = '',
      maxKeys = Infinity,
    } = options;
    const bucketPath = this.getBucketPath(bucket);

    const delimiterEnc = FilesystemStore.encodeKeyPath(delimiter);
    const startAfterPath = [
      bucketPath,
      FilesystemStore.encodeKeyPath(startAfter),
    ].join('/');
    const prefixPath = [bucketPath, FilesystemStore.encodeKeyPath(prefix)].join(
      '/',
    );

    const it = walk(bucketPath, dirPath => {
      // avoid directories occurring before the startAfter parameter
      if (dirPath < startAfterPath && startAfterPath.indexOf(dirPath) === -1) {
        return false;
      }
      if (dirPath.startsWith(prefixPath)) {
        if (
          delimiterEnc &&
          dirPath.slice(prefixPath.length).indexOf(delimiterEnc) !== -1
        ) {
          // avoid directories occurring beneath a common prefix
          return false;
        }
      } else if (!prefixPath.startsWith(dirPath)) {
        // avoid directories that do not intersect with any part of the prefix
        return false;
      }
      return true;
    });

    const commonPrefixes = new Set();
    const objectSuffix = format(S3RVER_SUFFIX, '', 'object');
    const keys = [];
    let isTruncated = false;
    for (const keyPath of it) {
      if (!keyPath.endsWith(objectSuffix)) {
        continue;
      }

      const key = FilesystemStore.decodeKeyPath(
        keyPath.slice(bucketPath.length + 1, -objectSuffix.length),
      );

      if (key <= startAfter || !key.startsWith(prefix)) {
        continue;
      }

      if (delimiter) {
        const idx = key.slice(prefix.length).indexOf(delimiter);
        if (idx !== -1) {
          // add to common prefixes before filtering this key out
          commonPrefixes.add(key.slice(0, prefix.length + idx + 1));
          continue;
        }
      }

      if (keys.length < maxKeys) {
        keys.push(key);
      } else {
        isTruncated = true;
        break;
      }
    }

    const metadataArr = await Promise.all(
      keys.map(key =>
        this.getMetadata(bucket, key).catch(err => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        }),
      ),
    );

    return {
      objects: zip(keys, metadataArr)
        .filter(([, metadata]) => metadata !== undefined)
        .map(([key, metadata]) => new S3Object(bucket, key, null, metadata)),
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated,
    };
  }

  async existsObject(bucket, key) {
    const objectPath = this.getResourcePath(bucket, key, 'object');
    try {
      await fs.stat(objectPath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async getObject(bucket, key, options) {
    try {
      const metadata = await this.getMetadata(bucket, key);
      const lastByte = Math.max(0, Number(metadata['content-length']) - 1);
      const range = {
        start: (options && options.start) || 0,
        end: Math.min((options && options.end) || Infinity, lastByte),
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
          .createReadStream(this.getResourcePath(bucket, key, 'object'), range)
          .on('error', reject)
          .on('open', () => resolve(stream));
      });
      const object = new S3Object(bucket, key, content, metadata);
      if (options && (options.start || options.end)) {
        object.range = range;
      }
      return object;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async postObject(object) {
    const objectPath = this.getResourcePath(
      object.bucket,
      object.key,
      'object',
    );

    await fs.mkdirp(path.dirname(objectPath));
    await fs.copy(object.content.path, objectPath);
    await fs.unlink(object.content.path);

    const md5 = md5File.sync(objectPath);
    await this.putMetadata(object.bucket, object.key, object.metadata, md5);
    return md5;
  }

  async putObject(object) {
    const objectPath = this.getResourcePath(
      object.bucket,
      object.key,
      'object',
    );

    await fs.mkdirp(path.dirname(objectPath));

    const [size, md5] = await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(objectPath);
      const md5Context = crypto.createHash('md5');
      let totalLength = 0;

      object.content
        .on('data', chunk => {
          writeStream.write(chunk, 'binary');
          md5Context.update(chunk, 'binary');
          totalLength += chunk.length;
        })
        .on('error', reject)
        .on('end', () => {
          writeStream.end();
          resolve([totalLength, md5Context.digest('hex')]);
        });
    });
    await this.putMetadata(object.bucket, object.key, object.metadata, md5);
    return { size, md5 };
  }

  async copyObject(
    srcBucket,
    srcKey,
    destBucket,
    destKey,
    replacementMetadata,
  ) {
    const srcObjectPath = this.getResourcePath(srcBucket, srcKey, 'object');
    const destObjectPath = this.getResourcePath(destBucket, destKey, 'object');

    if (srcObjectPath !== destObjectPath) {
      await fs.mkdirp(path.dirname(destObjectPath));
      await fs.copy(srcObjectPath, destObjectPath);
    }

    if (replacementMetadata) {
      await this.putMetadata(destBucket, destKey, replacementMetadata);
      return this.getMetadata(destBucket, destKey);
    } else {
      if (srcObjectPath !== destObjectPath) {
        await Promise.all([
          fs.copy(
            this.getResourcePath(srcBucket, srcKey, 'metadata.json'),
            this.getResourcePath(destBucket, destKey, 'metadata.json'),
          ),
          fs.copy(
            this.getResourcePath(srcBucket, srcKey, 'object.md5'),
            this.getResourcePath(destBucket, destKey, 'object.md5'),
          ),
        ]);
      }
      return this.getMetadata(destBucket, destKey);
    }
  }

  async deleteObject(bucket, key) {
    await Promise.all(
      [
        this.getResourcePath(bucket, key, 'object'),
        this.getResourcePath(bucket, key, 'object.md5'),
        this.getResourcePath(bucket, key, 'metadata.json'),
      ].map(filePath =>
        fs.unlink(filePath).catch(err => {
          if (err.code !== 'ENOENT') throw err;
        }),
      ),
    );
    // clean up empty directories
    const bucketPath = this.getBucketPath(bucket);
    const parts = key.split('/');
    // the last part isn't a directory (it's embedded into the file name)
    parts.pop();
    while (
      parts.length &&
      !fs.readdirSync(path.join(bucketPath, ...parts)).length
    ) {
      await fs.rmdir(path.join(bucketPath, ...parts));
      parts.pop();
    }
  }

  async initiateUpload(bucket, key, uploadId, metadata) {
    const uploadDir = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
    );

    await fs.mkdirp(uploadDir);

    await Promise.all([
      fs.writeFile(path.join(uploadDir, 'key'), key),
      fs.writeFile(path.join(uploadDir, 'metadata'), JSON.stringify(metadata)),
    ]);
  }

  async putPart(bucket, uploadId, partNumber, content) {
    const partPath = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
      partNumber.toString(),
    );

    await fs.mkdirp(path.dirname(partPath));

    const [size, md5] = await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(partPath);
      const md5Context = crypto.createHash('md5');
      let totalLength = 0;

      content
        .on('data', chunk => {
          writeStream.write(chunk, 'binary');
          md5Context.update(chunk, 'binary');
          totalLength += chunk.length;
        })
        .on('error', reject)
        .on('end', () => {
          writeStream.end();
          resolve([totalLength, md5Context.digest('hex')]);
        });
    });
    await fs.writeFile(`${partPath}.md5`, md5);
    return { size, md5 };
  }

  async putObjectMultipart(bucket, uploadId, parts) {
    const uploadDir = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
    );
    const [key, metadata] = await Promise.all([
      fs.readFile(path.join(uploadDir, 'key')).then(data => data.toString()),
      fs.readFile(path.join(uploadDir, 'metadata')).then(JSON.parse),
    ]);
    const partStreams = sortBy(parts, part => part.number).map(part =>
      fs.createReadStream(path.join(uploadDir, part.number.toString())),
    );
    const object = new S3Object(
      bucket,
      key,
      concatStreams(partStreams),
      metadata,
    );
    const result = await this.putObject(object);
    await fs.remove(uploadDir);
    return result;
  }

  async getSubresource(bucket, key, resourceType) {
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resourceType}.xml`,
    );

    const Model = getConfigModel(resourceType);

    try {
      const data = await fs.readFile(resourcePath);
      return new Model(data.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putSubresource(bucket, key, resource) {
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resource.type}.xml`,
    );
    await fs.writeFile(resourcePath, resource.toXML(2));
  }

  async deleteSubresource(bucket, key, resourceType) {
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resourceType}.xml`,
    );
    try {
      await fs.unlink(resourcePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = FilesystemStore;
