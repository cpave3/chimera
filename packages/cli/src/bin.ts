#!/usr/bin/env node
// The CLI lives in the sibling index.js, kept out of this bundle by the tsup config.
import { runCli } from './index.js';

process.title = 'chimera';
void runCli();
