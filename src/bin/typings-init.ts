#!/usr/bin/env node

import minimist = require('minimist')
import extend = require('xtend')
import { init } from '../typings'
import { loader } from '../utils/cli'
import { PROJECT_NAME } from '../utils/config'

interface Args {
  verbose: boolean
  help: boolean
}

const args = minimist<Args>(process.argv.slice(2), {
  boolean: ['verbose', 'help'],
  alias: {
    verbose: ['v'],
    help: ['h']
  }
})

if (args.help) {
  console.log(`
${PROJECT_NAME} init
`)

  process.exit(0)
}

const options = extend(args, { cwd: process.cwd() })

loader(init(options), options)
