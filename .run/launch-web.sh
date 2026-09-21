#!/bin/bash
cd /Users/louloulin/appx/genoffice
exec env PORT=18080 HOST=0.0.0.0 node apps/web-server/dist/bundle/index.js
