#!/usr/bin/env bash

set -ux

INSTANCE_IP="api.bespiral.io"

function update_files()
{
    rsync \
        --exclude='.git/' \
        --exclude='node_modules/' \
        -av "./" \
        ec2-user@"$INSTANCE_IP":~/event-source
}

update_files
# TODO: add npm i on server
# TODO: add restart service