// @flow
import { flattenDeep } from 'lodash';

import { actions, dispatch } from 'codesandbox-api';
import _debug from 'app/utils/debug';

import * as pathUtils from 'common/utils/path';

import type { Module } from './entities/module';
import type { SourceMap } from './transpilers/utils/get-source-map';
import ModuleError from './errors/module-error';
import ModuleWarning from './errors/module-warning';

import type { WarningStructure } from './transpilers/utils/worker-warning-handler';

import resolveDependency from './loaders/dependency-resolver';
import evaluate from './loaders/eval';

import Manager from './manager';

const debug = _debug('cs:compiler:transpiled-module');

type ChildModule = Module & {
  parent: Module,
};

class ModuleSource {
  fileName: string;
  compiledCode: string;
  sourceMap: ?SourceMap;

  constructor(fileName: string, compiledCode: string, sourceMap: ?SourceMap) {
    this.fileName = fileName;
    this.compiledCode = compiledCode;
    this.sourceMap = sourceMap;
  }
}

export type SerializedTranspiledModule = {
  module: Module,
  query: string,
  source: ?ModuleSource,
  assets: {
    [name: string]: ModuleSource,
  },
  isEntry: boolean,
  childModules: Array<string>,
  /**
   * All extra modules emitted by the loader
   */
  emittedAssets: Array<ModuleSource>,
  initiators: Array<string>, // eslint-disable-line no-use-before-define
  dependencies: Array<string>, // eslint-disable-line no-use-before-define
  asyncDependencies: Array<Promise<string>>, // eslint-disable-line no-use-before-define
  transpilationDependencies: Array<string>,
  transpilationInitiators: Array<string>,
};

export type LoaderContext = {
  emitWarning: (warning: WarningStructure) => void,
  emitError: (error: Error) => void,
  emitModule: (
    title: string,
    code: string,
    currentPath: string
  ) => TranspiledModule, // eslint-disable-line no-use-before-define
  emitFile: (name: string, content: string, sourceMap: SourceMap) => void,
  options: {
    context: '/',
    [key: string]: any,
  },
  webpack: boolean,
  sourceMap: boolean,
  target: string,
  path: string,
  getModules: () => Array<Module>,
  addDependency: (
    depPath: string,
    options: ?{
      isAbsolute: boolean,
    }
  ) => ?TranspiledModule, // eslint-disable-line no-use-before-define
  addDependenciesInDirectory: (
    depPath: string,
    options: {
      isAbsolute: boolean,
    }
  ) => Array<TranspiledModule>, // eslint-disable-line no-use-before-define
  _module: TranspiledModule, // eslint-disable-line no-use-before-define
};

type Compilation = {
  exports: any,
};

export default class TranspiledModule {
  module: Module;
  query: string;
  source: ?ModuleSource;
  assets: {
    [name: string]: ModuleSource,
  };
  isEntry: boolean;
  childModules: Array<TranspiledModule>;
  errors: Array<ModuleError>;
  warnings: Array<ModuleWarning>;
  /**
   * All extra modules emitted by the loader
   */
  emittedAssets: Array<ModuleSource>;
  compilation: ?Compilation;
  initiators: Set<TranspiledModule>; // eslint-disable-line no-use-before-define
  dependencies: Set<TranspiledModule>; // eslint-disable-line no-use-before-define
  asyncDependencies: Array<Promise<TranspiledModule>>; // eslint-disable-line no-use-before-define
  transpilationDependencies: Set<TranspiledModule>;
  transpilationInitiators: Set<TranspiledModule>;

  /**
   * Create a new TranspiledModule, a transpiled module is a module that contains
   * all info for transpilation and compilation. Note that there can be multiple
   * transpiled modules for 1 module, since a same module can have different loaders
   * attached using queries.
   * @param {*} module
   * @param {*} query A webpack query, eg: "url-loader?mimetype=image/png"
   */
  constructor(module: Module, query: string = '') {
    this.module = module;
    this.query = query;
    this.errors = [];
    this.warnings = [];
    this.childModules = [];
    this.transpilationDependencies = new Set();
    this.dependencies = new Set();
    this.asyncDependencies = [];
    this.transpilationInitiators = new Set();
    this.initiators = new Set();
    this.isEntry = false;
  }

  getId() {
    return `${this.module.path}:${this.query}`;
  }

  dispose() {
    this.reset();
  }

  reset() {
    this.childModules.forEach(m => {
      m.reset();
    });
    this.childModules = [];
    this.emittedAssets = [];
    this.resetCompilation();
    this.resetTranspilation();
    this.setIsEntry(false);
    // this.hmrEnabled = false;
  }

  resetTranspilation() {
    if (!this.hmrEnabled) {
      Array.from(this.transpilationInitiators)
        .filter(t => t.source)
        .forEach(dep => {
          dep.resetTranspilation();
        });
    }
    this.source = null;
    this.errors = [];
    this.warnings = [];

    if (!this.hmrEnabled) {
      Array.from(this.dependencies).forEach(t => {
        t.initiators.delete(this);
      });
    }
    this.dependencies.clear();
    this.asyncDependencies = [];
  }

  resetCompilation() {
    if (this.compilation) {
      try {
        if (!this.hmrEnabled) {
          this.compilation = null;
          Array.from(this.initiators)
            .filter(t => t.compilation)
            .forEach(dep => {
              dep.resetCompilation();
            });
        } else {
          console.log('changed', this.module);
          this.changed = true;
        }
      } catch (e) {
        console.error(e);
      }
    }

    if (!this.hmrEnabled) {
      Array.from(this.transpilationInitiators)
        .filter(t => t.compilation)
        .forEach(dep => {
          dep.resetCompilation();
        });
    }
  }

  update(module: Module): TranspiledModule {
    this.module = module;
    this.reset();

    return this;
  }

  createSourceForAsset = (
    name: string,
    content: string,
    sourceMap: SourceMap
  ) => new ModuleSource(name, content, sourceMap);

  getLoaderContext(
    manager: Manager,
    transpilerOptions: ?Object = {}
  ): LoaderContext {
    return {
      emitWarning: warning => {
        this.warnings.push(new ModuleWarning(this, warning));
      },
      emitError: error => {
        this.errors.push(new ModuleError(this, error));
      },
      emitModule: (
        path: string,
        code: string,
        directoryPath: string = pathUtils.dirname(this.module.path)
      ) => {
        const queryPath = path.split('!');
        // pop() mutates queryPath, queryPath is now just the loaders
        const modulePath = queryPath.pop();

        // Copy the module info, with new name
        const moduleCopy: ChildModule = {
          ...this.module,
          path: pathUtils.join(directoryPath, modulePath),
          parent: this.module,
          code,
        };

        const transpiledModule = manager.addTranspiledModule(
          moduleCopy,
          queryPath.join('!')
        );
        this.childModules.push(transpiledModule);

        this.dependencies.add(transpiledModule);
        transpiledModule.initiators.add(this);

        return transpiledModule;
      },
      emitFile: (name: string, content: string, sourceMap: SourceMap) => {
        this.assets[name] = this.createSourceForAsset(name, content, sourceMap);
      },
      // Add an explicit transpilation dependency, this is needed for loaders
      // that include the source of another file by themselves, we need to
      // force transpilation to rebuild the file
      addTranspilationDependency: (depPath: string, options) => {
        const tModule = manager.resolveTranspiledModule(
          depPath,
          options && options.isAbsolute ? '/' : this.module.path
        );

        this.transpilationDependencies.add(tModule);
        tModule.transpilationInitiators.add(this);

        return tModule;
      },
      addDependency: (depPath: string, options) => {
        if (
          depPath.startsWith('babel-runtime') ||
          depPath.startsWith('codesandbox-api')
        ) {
          return null;
        }

        try {
          const tModule = manager.resolveTranspiledModule(
            depPath,
            options && options.isAbsolute ? '/' : this.module.path
          );

          this.dependencies.add(tModule);
          tModule.initiators.add(this);

          return tModule;
        } catch (e) {
          if (e.type === 'module-not-found' && e.isDependency) {
            this.asyncDependencies.push(
              manager.downloadDependency(e.path, this.module.path)
            );
          } else {
            // Don't throw the error, we want to throw this error during evaluation
            // so we get the correct line as error
            if (process.env.NODE_ENV === 'development') {
              console.error(e);
            }
          }
        }
      },
      addDependenciesInDirectory: (folderPath: string, options) => {
        const tModules = manager.resolveTranspiledModulesInDirectory(
          folderPath,
          options && options.isAbsolute ? '/' : this.module.path
        );

        tModules.forEach(tModule => {
          this.dependencies.add(tModule);
          tModule.initiators.add(this);
        });

        return tModules;
      },
      getModules: (): Array<Module> => manager.getModules(),
      options: {
        context: '/',
        ...transpilerOptions,
      },
      webpack: true,
      sourceMap: true,
      target: 'web',
      _module: this,
      path: this.module.path,
    };
  }

  /**
   * Mark the transpiled module as entry (or not), this is needed to let the
   * cleanup know that this module can have no initiators, but is still required.
   * @param {*} isEntry
   */
  setIsEntry(isEntry: boolean) {
    this.isEntry = isEntry;
  }

  /**
   * Transpile the module, it takes in all loaders from the default loaders +
   * query string and passes the result from loader to loader. During transpilation
   * dependencies can be added, these dependencies will be transpiled concurrently
   * after the initial transpilation finished.
   * @param {*} manager
   */
  async transpile(manager: Manager) {
    if (this.source) {
      return this;
    }

    // Remove this module from the initiators of old deps, so we can populate a
    // fresh cache
    this.dependencies.forEach(tModule => {
      tModule.initiators.delete(this);
    });
    this.dependencies.clear();
    this.errors = [];
    this.warnings = [];

    let code = this.module.code || '';
    let finalSourceMap = null;

    if (this.module.requires) {
      // We now know that this has been transpiled on the server, so we shortcut
      const loaderContext = this.getLoaderContext(manager, {});
      // These are precomputed requires, for npm dependencies
      this.module.requires.forEach(loaderContext.addDependency);

      code = this.module.code;
    } else {
      const transpilers = manager.preset.getLoaders(this.module, this.query);

      const t = Date.now();
      for (let i = 0; i < transpilers.length; i += 1) {
        const transpilerConfig = transpilers[i];
        const loaderContext = this.getLoaderContext(
          manager,
          transpilerConfig.options || {}
        );
        try {
          const {
            transpiledCode,
            sourceMap,
          } = await transpilerConfig.transpiler.transpile(code, loaderContext); // eslint-disable-line no-await-in-loop

          if (this.warnings.length) {
            this.warnings.forEach(warning => {
              console.warn(warning.message); // eslint-disable-line no-console
              dispatch(
                actions.correction.show(warning.message, {
                  line: warning.lineNumber,
                  column: warning.columnNumber,
                  path: warning.path,
                  source: warning.source,
                  severity: 'warning',
                })
              );
            });
          }

          if (this.errors.length) {
            throw this.errors[0];
          }

          code = transpiledCode;
          finalSourceMap = sourceMap;
        } catch (e) {
          e.fileName = loaderContext.path;
          e.tModule = this;
          this.resetTranspilation();
          throw e;
        }
        debug(`Transpiled '${this.getId()}' in ${Date.now() - t}ms`);
      }
    }

    // Add the source of the file by default, this is important for source mapping
    // errors back to their origin
    code = `${code}\n//# sourceURL=${location.origin}${this.module.path}`;

    this.source = new ModuleSource(this.module.path, code, finalSourceMap);

    await Promise.all(
      this.asyncDependencies.map(async p => {
        try {
          const tModule = await p;

          this.dependencies.add(tModule);
          tModule.initiators.add(this);
        } catch (e) {
          /* let this handle at evaluation */
        }
      })
    );

    this.asyncDependencies = [];

    await Promise.all(
      flattenDeep([
        ...Array.from(this.transpilationInitiators).map(t =>
          t.transpile(manager)
        ),
        ...Array.from(this.dependencies).map(t => t.transpile(manager)),
      ])
    );

    return this;
  }

  getChildTranspiledModules(): Array<TranspiledModule> {
    return flattenDeep(
      this.childModules.map(m => [m, ...m.getChildTranspiledModules()])
    );
  }

  getChildModules(): Array<Module> {
    return flattenDeep(
      this.childModules.map(m => [m.module, ...m.getChildModules()])
    );
  }

  evaluate(manager: Manager, parentModules: Array<TranspiledModule>) {
    if (this.source == null) {
      throw new Error(`${this.module.path} hasn't been transpiled yet.`);
    }

    const localModule = this.module;

    if (manager.webpackHMR) {
      if (!this.compilation && this.isEntry && !this.hmrEnabled) {
        location.reload();
        return {};
      }
    }

    if (this.compilation && !this.changed) {
      return this.compilation.exports;
    }

    if (this.changed && this.hmrEnabled) {
      console.log('hoooi');
    }
    this.compilation = this.compilation || {
      exports: {},
      hot: {
        accept: (path: string, cb) => {
          if (path) {
            const tModule = manager.resolveTranspiledModule(
              path,
              this.module.path
            );
            tModule.hmrEnabled = cb;
            console.log(tModule);
          } else {
            this.hmrEnabled = true;
          }
          manager.webpackHMR = true;
        },
      },
    };
    const transpiledModule = this;

    try {
      // eslint-disable-next-line no-inner-declarations
      function require(path: string) {
        // First check if there is an alias for the path, in that case
        // we must alter the path to it
        const aliasedPath = manager.preset.getAliasedPath(path);

        // eslint-disable-line no-unused-vars
        if (/^(\w|@\w)/.test(aliasedPath) && !aliasedPath.includes('!')) {
          // So it must be a dependency
          if (
            aliasedPath.startsWith('babel-runtime') ||
            aliasedPath.startsWith('codesandbox-api')
          )
            return resolveDependency(aliasedPath, manager.externals);
        }

        const requiredTranspiledModule = manager.resolveTranspiledModule(
          aliasedPath,
          localModule.path
        );

        if (localModule === requiredTranspiledModule.module) {
          throw new Error(`${localModule.path} is importing itself`);
        }

        return manager.evaluateTranspiledModule(requiredTranspiledModule, [
          ...parentModules,
          transpiledModule,
        ]);
      }

      const exports = evaluate(
        this.source.compiledCode,
        require,
        this.compilation,
        manager.envVariables
      );

      if (typeof this.hmrEnabled === 'function') {
        this.hmrEnabled();
      }

      return exports;
    } catch (e) {
      e.tModule = e.tModule || transpiledModule;

      throw e;
    }
  }

  postEvaluate(manager: Manager) {
    // For non cacheable transpilers we remove the cached evaluation
    if (
      manager.preset
        .getLoaders(this.module, this.query)
        .some(t => !t.transpiler.cacheable)
    ) {
      this.compilation = null;
    }

    // There are no other modules calling this module, so we run a function on
    // all transpilers that clears side effects if there are any. Example:
    // Remove CSS styles from the dom.
    if (this.initiators.size === 0 && !this.isEntry) {
      manager.preset.getLoaders(this.module, this.query).forEach(t => {
        t.transpiler.cleanModule(this.getLoaderContext(manager, t.options));
      });
    }
  }

  serialize(): SerializedTranspiledModule {
    const serializableObject = {};

    serializableObject.query = this.query;
    serializableObject.assets = this.assets;
    serializableObject.module = this.module;
    serializableObject.emittedAssets = this.emittedAssets;
    serializableObject.isEntry = this.isEntry;
    serializableObject.source = this.source;
    serializableObject.childModules = this.childModules.map(m => m.getId());
    serializableObject.dependencies = Array.from(this.dependencies).map(m =>
      m.getId()
    );
    serializableObject.initiators = Array.from(this.initiators).map(m =>
      m.getId()
    );
    serializableObject.transpilationDependencies = Array.from(
      this.transpilationDependencies
    ).map(m => m.getId());
    serializableObject.transpilationInitiators = Array.from(
      this.transpilationInitiators
    ).map(m => m.getId());

    serializableObject.asyncDependencies = [];
    // At this stage we know that all modules are already resolved and the promises
    // are downloaded. So we can just handle this synchronously.
    Array.from(this.asyncDependencies).forEach(m => {
      m.then(x => {
        serializableObject.asyncDependencies.push(x.getId());
      });
    });

    return (serializableObject: SerializedTranspiledModule);
  }

  async load(
    data: SerializedTranspiledModule,
    state: { [id: string]: TranspiledModule }
  ) {
    this.query = data.query;
    this.assets = data.assets;
    this.module = data.module;
    this.emittedAssets = data.emittedAssets;
    this.isEntry = data.isEntry;
    this.source = data.source;

    data.dependencies.forEach((depId: string) => {
      this.dependencies.add(state[depId]);
    });
    data.childModules.forEach((depId: string) => {
      this.childModules.push(state[depId]);
    });
    data.initiators.forEach((depId: string) => {
      this.initiators.add(state[depId]);
    });
    data.transpilationDependencies.forEach((depId: string) => {
      this.transpilationDependencies.add(state[depId]);
    });
    data.asyncDependencies.forEach((depId: string) => {
      this.asyncDependencies.push(Promise.resolve(state[depId]));
    });
  }
}
