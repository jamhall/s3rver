"use strict";

const async = require("async");
const crypto = require("crypto");
const fs = require("fs-extra");
const {
    entries,
    isUndefined,
    omitBy,
    sortBy
} = require("lodash");
const path = require("path");

const Bucket = require("../models/bucket");
const S3Object = require("../models/s3-object");
const utils = require("../utils");

const CONTENT_FILE = ".dummys3_content";
const METADATA_FILE = ".dummys3_metadata";

class FilesystemStore {
    constructor(rootDirectory) {
        this.rootDirectory = rootDirectory;
    }

    // helpers

    getBucketPath(bucketName) {
        return path.join(this.rootDirectory, bucketName);
    }

    getFilenameFromKey(key) {
        const pathParts = key.split('/');
        return pathParts[pathParts.length - 1].indexOf('.') > -1 ? pathParts[pathParts.length - 1] : CONTENT_FILE;
    }

    getMetaDataFilename(filename) {
        return filename === CONTENT_FILE ? METADATA_FILE : `${filename}_meta`;
    }

    getMD5Filename(filename) {
        return filename === CONTENT_FILE ? `${CONTENT_FILE}.md5` : `${filename}.md5`;
    }

    getPathFromKey(key) {
        const pathParts = key.split('/');
        pathParts.pop();
        return pathParts.length > 0 ? pathParts.join('/')+'/' : '';
    }

    retrieveMetadata(bucket, key, done) {
        const filename = this.getFilenameFromKey(key);
        if (filename !== CONTENT_FILE) {
            key = this.getPathFromKey(key);
        }

        const contentPath = path.join(
            this.getBucketPath(bucket),
            key,
            filename
        );
        const metadataPath = path.join(
            this.getBucketPath(bucket),
            key,
            this.getMetaDataFilename(filename)
        );

        async.parallel(
            [
                callback =>
                fs.readFile(metadataPath, (err, data) => {
                    if (err) return callback(err);
                    callback(null, JSON.parse(data));
                }),
                callback => fs.stat(contentPath, callback),
                callback => {
                    fs.readFile(contentPath + ".md5", (err, md5) => {
                        if (err && err.code !== "ENOENT") return callback(err);
                        if (md5) return callback(null, md5.toString());
                        // create the md5 file if it doesn't already exist
                        const md5Context = crypto.createHash("md5");
                        const stream = fs.createReadStream(contentPath);

                        stream.on("error", callback);
                        stream.on("data", chunk => md5Context.update(chunk, "utf8"));
                        stream.on("end", () => {
                            md5 = md5Context.digest("hex");
                            fs.writeFile(contentPath + ".md5", md5, () =>
                                callback(null, md5)
                            );
                        });
                    });
                }
            ],
            (err, [storedMetadata, stats, md5] = []) => {
                if (err) return done(err);

                const metadata = omitBy({
                        "cache-control": storedMetadata.cacheControl,
                        "content-disposition": storedMetadata.contentDisposition,
                        "content-encoding": storedMetadata.contentEncoding,
                        "content-language": storedMetadata.contentLanguage,
                        "content-type": storedMetadata.contentType,
                        expires: storedMetadata.expires,
                        "website-redirect-location": storedMetadata.websiteRedirectLocation,

                        "last-modified": stats.mtime.toUTCString(),
                        etag: JSON.stringify(md5),
                        "content-length": stats.size
                    },
                    isUndefined
                );

                for (const [key, value] of storedMetadata.customMetaData) {
                    metadata["x-amz-meta-" + key] = value;
                }

                done(null, metadata);
            }
        );
    }

    storeMetadata(bucket, key, metadata, md5, done) {
        if (typeof md5 === "function") {
            done = md5;
            md5 = null;
        }

        const filename = this.getFilenameFromKey(key);
        if (filename !== CONTENT_FILE) {
            key = this.getPathFromKey(key);
        }

        const metadataFile = path.join(
            this.getBucketPath(bucket),
            key,
            this.getMetaDataFilename(filename)
        );
        const md5File = path.join(
            this.getBucketPath(bucket),
            key,
            this.getMD5Filename(filename)
        );

        // this is only for backwards compatibility purposes
        // otherwise we can just dump the result of JSON.stringify(metadata) into the file

        const json = {
            cacheControl: metadata["cache-control"],
            contentDisposition: metadata["content-disposition"],
            contentEncoding: metadata["content-encoding"],
            contentLanguage: metadata["content-language"],
            contentType: metadata["content-type"],
            expires: metadata["expires"],
            websiteRedirectLocation: metadata["website-redirect-location"]
        };
        json.customMetaData = entries(metadata)
            .filter(([header]) => header.startsWith("x-amz-meta-"))
            .map(([header, value]) => [header.replace("x-amz-meta-", ""), value]);

        if (md5) {
            fs.writeFileSync(md5File, md5);
        }
        fs.writeFile(metadataFile, JSON.stringify(json), done);
    }

    // store implementation

    getBuckets() {
        const buckets = [];
        for (const filename of fs.readdirSync(this.rootDirectory)) {
            const file = fs.statSync(path.resolve(this.rootDirectory, filename));
            if (file.isDirectory()) {
                buckets.push(new Bucket(filename, file.ctime));
            }
        }
        return buckets;
    }

    getBucket(bucket, done) {
        const bucketPath = this.getBucketPath(bucket);
        fs.stat(bucketPath, (err, file) => {
            if (err) return done(err.code === "ENOENT" ? null : err);
            if (!file.isDirectory()) return done();
            done(null, new Bucket(bucket, file.ctime));
        });
    }

    putBucket(bucket, done) {
        const bucketPath = this.getBucketPath(bucket);
        fs.mkdirp(bucketPath, 502, err => {
            if (err) return done(err);
            this.getBucket(bucket, done);
        });
    }

    deleteBucket(bucket, done) {
        fs.rmdir(this.getBucketPath(bucket), done);
    }

    listObjects(bucket, options, done) {
        const bucketPath = this.getBucketPath(bucket);
        const commonPrefixes = new Set();
        let keys = utils
            .walk(bucketPath)
            .map(key => key.slice(bucketPath.length + 1));

        if (!keys.length) {
            return done(null, {
                objects: [],
                commonPrefixes: [],
                isTruncated: false
            });
        }

        if (options.prefix) {
            keys = keys.filter(key => key.startsWith(options.prefix));
        }

        if (options.delimiter) {
            const prefix = options.prefix || "";
            keys = keys.filter(key => {
                let idx = key.slice(prefix.length).indexOf(options.delimiter);
                idx = key.indexOf('.') === -1 && idx === -1 ? key.length : -1
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

        async.map(
            keys,
            (key, callback) => {
                this.retrieveMetadata(bucket, key, (err, metadata) => {
                    if (err) return callback(err.code === "ENOENT" ? null : err);
                    callback(null, new S3Object(bucket, key, null, metadata));
                });
            },
            (err, objects) => {
                if (err) return done(err);
                objects = objects.filter(o => o !== undefined);
                done(null, {
                    objects: objects.slice(0, options.maxKeys),
                    commonPrefixes: [...commonPrefixes].sort(),
                    isTruncated: objects.length > options.maxKeys
                });
            }
        );
    }

    existsObject(bucket, key, done) {
        const filename = this.getFilenameFromKey(key);
        if (filename !== CONTENT_FILE) {
            key = this.getPathFromKey(key);
        }
        const dirName = path.join(this.getBucketPath(bucket), key, filename);
        fs.stat(dirName, err => {
            if (err) {
                return err.code === "ENOENT" ? done(null, false) : done(err);
            }
            done(null, true);
        });
    }

    getObject(bucket, key, options, done) {
        if (typeof options === "function") {
            done = options;
            options = undefined;
        }

        const filename = this.getFilenameFromKey(key);
        let keyPath = key;
        if (filename !== CONTENT_FILE) {
            keyPath = this.getPathFromKey(key);
        }
        const dirName = path.join(this.getBucketPath(bucket), keyPath);
        async.parallel(
            [
                callback => {
                    const readStream = fs
                        .createReadStream(path.join(dirName, filename), options)
                        .on("error", callback)
                        .on("open", () => callback(null, readStream));
                },
                callback => this.retrieveMetadata(bucket, key, callback)
            ],
            (err, [content, metadata] = []) => {
                if (err) return done(err.code === "ENOENT" ? null : err);
                const object = new S3Object(bucket, key, content, metadata);
                if (options && (options.start || options.end)) {
                    object.range = {
                        start: options.start || 0,
                        end: options.end || object.size - 1
                    };
                }
                return done(null, object);
            }
        );
    }

    putObject(object, done) {
        const filename = this.getFilenameFromKey(object.key);
        let keyPath = object.key;
        if (filename !== CONTENT_FILE) {
            keyPath = this.getPathFromKey(object.key);
        }
        const dirName = path.join(this.getBucketPath(object.bucket), keyPath);

        fs.mkdirpSync(dirName);

        const writeStream = fs.createWriteStream(path.join(dirName, filename));
        const md5Context = crypto.createHash("md5");
        let size = 0;
        object.content
            .on("data", chunk => {
                writeStream.write(chunk, "binary");
                md5Context.update(chunk, "binary");
                size += chunk.length;
            })
            .on("error", done)
            .on("end", () => {
                writeStream.end();
                // TODO: iff metadata found in object
                const md5 = md5Context.digest("hex");
                this.storeMetadata(
                    object.bucket,
                    object.key,
                    object.metadata,
                    md5,
                    err => {
                        if (err) return done(err);
                        done(null, md5, size);
                    }
                );
            });
    }

    copyObject(srcBucket, srcKey, destBucket, destKey, replacementMetadata, done) {
        const srcFilename = this.getFilenameFromKey(srcKey);
        let srcPath = srcKey;
        if (srcFilename !== CONTENT_FILE) {
            srcPath = this.getPathFromKey(srcKey);
        }
        const destFilename = this.getFilenameFromKey(destKey);
        let destPath = destKey;
        if (destFilename !== CONTENT_FILE) {
            destPath = this.getPathFromKey(destKey);
        }

        const srcKeyPath = path.join(this.getBucketPath(srcBucket), srcPath);
        const destKeyPath = path.join(this.getBucketPath(destBucket), destPath);
        const srcContentPath = path.join(srcKeyPath, srcFilename);
        const srcMetadataPath = path.join(srcKeyPath, this.getMetaDataFilename(srcFilename));
        const destContentPath = path.join(destKeyPath, destFilename);
        const destMetadataPath = path.join(destKeyPath, this.getMetaDataFilename(destFilename));

        try {
            // if (srcKeyPath !== destKeyPath) {
            if(srcContentPath !== destContentPath) {
                fs.mkdirpSync(destKeyPath || destContentPath);
                fs.copySync(srcContentPath, destContentPath);
            }

            if (replacementMetadata) {
                this.storeMetadata(destBucket, destKey, replacementMetadata, err => {
                    if (err) return done(err);
                    this.retrieveMetadata(destBucket, destKey, done);
                });
            } else {
                if (srcContentPath !== destContentPath) {
                    fs.copySync(srcMetadataPath, destMetadataPath);
                }
                this.retrieveMetadata(destBucket, destKey, done);
            }
        } catch (err) {
            done(err);
        }
    }

    deleteObject(bucket, key, done) {
        const filename = this.getFilenameFromKey(key);
        let keyPath = key;
        if (filename !== CONTENT_FILE) {
            keyPath = this.getPathFromKey(key);
        }
        const bucketPath = this.getBucketPath(bucket);
        async.map(
            [
                path.join(bucketPath, keyPath, filename),
                path.join(bucketPath, keyPath, this.getMD5Filename(filename)),
                path.join(bucketPath, keyPath, this.getMetaDataFilename(filename))
            ],
            (filePath, callback) => {
                fs.unlink(filePath, err =>
                    callback(err && err.code !== "ENOENT" ? err : null)
                );
            },
            err => {
                if (err && err.code !== "ENOENT") return done(err);

                fs.rmdir(keyPath, () => {
                    utils.removeEmptyDirectories(fs, bucketPath, () => done());
                });
            }
        );
    }

    putObjectMultipart(bucket, key, uploadId, parts, metadata, done) {
        const filename = this.getFilenameFromKey(key);
        if (filename !== CONTENT_FILE) {
            key = this.getPathFromKey(key);
        }

        const partPaths = sortBy(parts, part => part.number).map(part => {
            return path.join(
                this.getBucketPath(bucket),
                uploadId + "_" + part.number
            );
        });
        const partStreams = partPaths.map(partPath => {
            const stream = fs.createReadStream(path.join(partPath, filename));
            stream.on("close", err => {
                if (!err) fs.removeSync(partPath);
            });
            return stream;
        });
        const object = new S3Object(
            bucket,
            key,
            utils.concatStreams(partStreams),
            metadata
        );
        this.putObject(object, done);
    }
}

module.exports = FilesystemStore;