import * as fs from 'graceful-fs'
import thenify = require('thenify')
import stripBom = require('strip-bom')
import parse = require('parse-json')
import popsicle = require('popsicle')
import popsicleCache = require('popsicle-cache')
import popsicleStatus = require('popsicle-status')
import detectIndent = require('detect-indent')
import sortKeys = require('sort-keys')
import mdp = require('mkdirp')
import uniq = require('array-uniq')
import Promise = require('native-or-bluebird')
import lockfile = require('lockfile')
import { join, dirname } from 'path'
import { CONFIG_FILE, TYPINGS_DIR, DTS_MAIN_FILE, DTS_BROWSER_FILE, CACHE_DIR } from './config'
import { isHttp, toDefinition } from './path'
import { parseReferences, stringifyReferences } from './references'
import { ConfigJson } from '../interfaces/main'

// Create a file cache for popsicle.
const requestFileCache = popsicleCache({
  store: new popsicleCache.Store({ path: join(CACHE_DIR, 'http') })
})

const mainTypingsDir = join(TYPINGS_DIR, 'definitions/main')
const browserTypingsDir = join(TYPINGS_DIR, 'definitions/browser')
const ambientMainTypingsDir = join(TYPINGS_DIR, 'ambient/main')
const ambientBrowserTypingsDir = join(TYPINGS_DIR, 'ambient/browser')

export type Stats = fs.Stats

export const stat = thenify(fs.stat)
export const readFile = thenify<string, string, string>(fs.readFile)
export const writeFile = thenify<string, string | Buffer, void>(fs.writeFile)
export const mkdirp = thenify<string, void>(mdp)
export const unlink = thenify<string, void>(fs.unlink)
export const lock = thenify(lockfile.lock)
export const unlock = thenify(lockfile.unlock)

/**
 * Verify a path exists and is a file.
 */
export function isFile (path: string): Promise<boolean> {
  return stat(path).then(stat => stat.isFile(), () => false)
}

/**
 * Read JSON from a path.
 */
export function readJson (path: string): Promise<any> {
  return readFile(path, 'utf8')
    .then(stripBom)
    .then(contents => parseJson(contents, path))
}

/**
 * Write JSON to a file.
 */
export function writeJson (path: string, json: any, indent: string | number = 2) {
  return writeFile(path, JSON.stringify(json, null, indent))
}

/**
 * Read a configuration file.
 */
export function readConfig (path: string): Promise<ConfigJson> {
  return readJson(path).then(data => parseConfig(data, path))
}

/**
 * Read a configuration file from anywhere (HTTP or local).
 */
export function readConfigFrom (path: string): Promise<ConfigJson> {
  return readJsonFrom(path).then(data => parseConfig(data, path))
}

export function parseConfig (config: ConfigJson, path: string): ConfigJson {
  // TODO(blakeembrey): Validate config object.
  return config
}

/**
 * Read a file over HTTP, using a file cache and status check.
 */
export function readHttp (url: string): Promise<string> {
  return popsicle.get({
    url,
    use: [
      popsicle.plugins.headers,
      popsicle.plugins.unzip,
      popsicle.plugins.concatStream('string')
    ]
  })
    .use(requestFileCache)
    .use(popsicleStatus(200))
    .then(x => x.body)
}

/**
 * Read a file from anywhere (HTTP or local filesystem).
 */
export function readFileFrom (from: string): Promise<string> {
  return isHttp(from) ? readHttp(from) : readFile(from, 'utf8')
}

/**
 * Read JSON from anywhere.
 */
export function readJsonFrom (from: string): Promise<any> {
  return readFileFrom(from)
    .then(stripBom)
    .then(contents => parseJson(contents, from))
}

/**
 * Parse a string as JSON.
 */
export function parseJson (contents: string, path: string) {
  return parse(contents, null, path)
}

/**
 * Transform a file contents (read and write in a single operation).
 */
export function transformFile (path: string, transform: (contents: string) => string | Promise<string>) {
  function handle (contents: string) {
    return Promise.resolve(transform(contents))
      .then(contents => writeFile(path, contents))
  }

  const lockfile = `${path}.lock`

  return lock(lockfile)
    .then(() => {
      return readFile(path, 'utf8')
    })
    .then(
      (contents) => handle(contents),
      () => handle(undefined)
    )
    .then(() => unlock(lockfile))
}

/**
 * Transform a JSON file in a single operation.
 */
export function transformJson <T> (path: string, transform: (json: T) => T) {
  return transformFile(path, (contents) => {
    const indent = contents ? detectIndent(contents).indent : 2
    const json = contents ? parseJson(contents, path) : undefined

    return Promise.resolve(transform(json))
      .then(json => JSON.stringify(json, null, indent || 2))
  })
}

/**
 * Transform a configuration file in a single operation.
 */
export function transformConfig (cwd: string, transform: (config: ConfigJson) => ConfigJson) {
  const path = join(cwd, CONFIG_FILE)

  return transformJson<ConfigJson>(path, (config = {}) => {
    return Promise.resolve(transform(parseConfig(config, path)))
      .then(config => {
        if (config.dependencies) {
          config.dependencies = sortKeys(config.dependencies)
        }

        if (config.devDependencies) {
          config.devDependencies = sortKeys(config.devDependencies)
        }

        if (config.ambientDependencies) {
          config.ambientDependencies = sortKeys(config.ambientDependencies)
        }

        return config
      })
  })
}

export function transformDtsFile (path: string, transform: (typings: string[]) => string[]) {
  const cwd = dirname(path)

  return transformFile(path, contents => {
    const typings = parseReferences(contents, cwd)

    return Promise.resolve(transform(typings))
      .then(typings => stringifyReferences(uniq(typings).sort(), cwd))
  })
}

/**
 * Options for interacting with dependencies.
 */
export interface DefinitionOptions {
  cwd: string
  name: string
  ambient: boolean
}

/**
 * Write a dependency to the filesytem.
 */
export function writeDependency (contents: { main: string; browser: string }, options: DefinitionOptions): Promise<boolean> {
  const { mainFile, browserFile, mainDtsFile, browserDtsFile } = getDependencyLocation(options)

  return Promise.all([
    mkdirp(dirname(mainFile)),
    mkdirp(dirname(browserFile))
  ])
    .then(() => {
      return Promise.all([
        writeFile(mainFile, contents.main || ''),
        writeFile(browserFile, contents.browser || '')
      ])
    })
    .then(() => {
      return Promise.all([
        transformDtsFile(mainDtsFile, typings => typings.concat([mainFile])),
        transformDtsFile(browserDtsFile, typings => typings.concat([browserFile]))
      ])
    })
    .then(() => undefined)
}

/**
 * Remove a dependency from the filesystem.
 */
export function removeDependency (options: DefinitionOptions) {
  const { mainFile, browserFile, mainDtsFile, browserDtsFile } = getDependencyLocation(options)

  return Promise.all([
    unlink(mainFile).catch(() => false),
    unlink(browserFile).catch(() => false)
  ])
    .then(() => {
      return Promise.all([
        transformDtsFile(mainDtsFile, typings => typings.filter(x => x !== mainFile)),
        transformDtsFile(browserDtsFile, typings => typings.filter(x => x !== browserFile))
      ])
    })
    .then(() => undefined)
}

/**
 * Return the dependency output locations based on definition options.
 */
function getDependencyLocation (options: DefinitionOptions) {
  const typingsDir = join(options.cwd, TYPINGS_DIR)
  const mainDtsFile = join(typingsDir, DTS_MAIN_FILE)
  const browserDtsFile = join(typingsDir, DTS_BROWSER_FILE)
  const mainDir = options.ambient ? ambientMainTypingsDir : mainTypingsDir
  const browserDir = options.ambient ? ambientBrowserTypingsDir : browserTypingsDir
  const mainFile = join(options.cwd, mainDir, toDefinition(options.name))
  const browserFile = join(options.cwd, browserDir, toDefinition(options.name))

  return { mainFile, browserFile, mainDtsFile, browserDtsFile }
}
