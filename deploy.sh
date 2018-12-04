#!/usr/bin/env bash

set -ux

INSTANCE_IP="dev-api.bespiral.io"

function update_files()
{
    rsync \
        --exclude='.git/' \
        -av "./" \
        backend@"$INSTANCE_IP":~/event-source
}

update_files
