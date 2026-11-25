import fs from 'fs';
import path from 'path';
import Module, { createRequire } from 'module';
import { pathToFileURL } from 'url';
import type * as TypeScript from 'typescript';

const SCRIPT_EXTENSIONS = ['.ts', '.cts', '.js', '.cjs', '.mjs'];
const TYPESCRIPT_EXTENSIONS = ['.ts', '.cts'];

type ModuleLoader = (module: NodeModule, filename: string) => void;

let typescriptRegistered = false;

// tsc would turn a plain `import()` into `require()`, so we keep a real one around for ESM-only files.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/**
 * Requires a package as if it was required from the project being migrated,
 * falling back to gina's own copy when the project doesn't have it.
 */
function requireFromProject<T>(cwd: string, id: string): T {
    try {
        return createRequire(path.join(cwd, 'package.json'))(id);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
            throw err;
        }
        return require(id);
    }
}

function readCompilerOptions(ts: typeof TypeScript, cwd: string): TypeScript.CompilerOptions {
    const defaults = { target: ts.ScriptTarget.ES2021, esModuleInterop: true };

    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists);
    if (!configPath) {
        return defaults;
    }

    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) {
        return defaults;
    }

    return ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath)).options;
}

/**
 * Teaches `require` how to load TypeScript files, using the project's own `typescript` and tsconfig.
 * It only transpiles (no type checking), always to CommonJS, so it doesn't depend on ts-node
 * or on Node's experimental loaders and behaves the same on every Node version.
 */
function registerTypeScript(cwd: string) {
    if (typescriptRegistered) {
        return;
    }
    typescriptRegistered = true;

    const ts = requireFromProject<typeof TypeScript>(cwd, 'typescript');
    const compilerOptions: TypeScript.CompilerOptions = {
        ...readCompilerOptions(ts, cwd),
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        verbatimModuleSyntax: false,
        inlineSourceMap: true,
        inlineSources: true,
        sourceMap: false,
        sourceRoot: undefined,
        // with outDir, sources are written relative to it and stack traces point to the wrong folder
        outDir: undefined,
        mapRoot: undefined,
        declaration: false,
        noEmit: false,
    };

    process.setSourceMapsEnabled(true);

    const extensions = (Module as unknown as { _extensions: Record<string, ModuleLoader>; })._extensions;
    for (const extension of TYPESCRIPT_EXTENSIONS) {
        extensions[extension] = (module, filename) => {
            // require hooks are synchronous by design
            // eslint-disable-next-line no-sync
            const source = fs.readFileSync(filename, 'utf8');
            const { outputText } = ts.transpileModule(source, { fileName: filename, compilerOptions });
            (module as unknown as { _compile(code: string, filename: string): void; })._compile(outputText, filename);
        };
    }
}

/**
 * Loads a .ts/.js file from the project. TypeScript is transpiled on the fly,
 * ESM-only JavaScript falls back to a native `import()`.
 */
async function loadModule(filePath: string, cwd: string) {
    if (TYPESCRIPT_EXTENSIONS.includes(path.extname(filePath))) {
        registerTypeScript(cwd);
    }

    try {
        return require(filePath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ERR_REQUIRE_ESM' && code !== 'ERR_REQUIRE_ASYNC_MODULE') {
            throw err;
        }
        return nativeImport(pathToFileURL(filePath).href);
    }
}

/**
 * Lists the scripts inside a folder sorted by name, ignoring typings and source maps.
 * When the same script exists as .ts and .js the .ts one wins.
 */
async function listScripts(dir: string) {
    const scripts = new Map<string, string>();

    for (const file of await fs.promises.readdir(dir)) {
        const extension = path.extname(file);
        if (!SCRIPT_EXTENSIONS.includes(extension) || /\.d\.[cm]?ts$/.test(file)) {
            continue;
        }

        const name = file.slice(0, -extension.length);
        if (!scripts.has(name) || TYPESCRIPT_EXTENSIONS.includes(extension)) {
            scripts.set(name, path.join(dir, file));
        }
    }

    return [...scripts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, filePath]) => ({ name, filePath }));
}

export { requireFromProject, loadModule, listScripts };
