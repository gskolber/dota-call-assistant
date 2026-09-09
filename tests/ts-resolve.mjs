import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !path.extname(specifier)) {
      const from = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
      const candidate = path.resolve(from, `${specifier}.ts`);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
