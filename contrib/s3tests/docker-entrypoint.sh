#!/bin/sh
envsubst < /etc/s3tests.conf.template > /etc/s3tests.conf
exec $@