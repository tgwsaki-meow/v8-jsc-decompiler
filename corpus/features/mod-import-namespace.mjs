// mod-import-namespace -- namespace import
// group=module module strict
'use strict';
import * as ns from './mod-dep.mjs';
T('namespace', Object.keys(ns).sort()); T('viaNamespace', [ns.named, ns.default()]);
