import { resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import fastGlob from 'fast-glob';
import { normalizePath } from 'vite';
import parseFile from './parser';
import { transformEnvImports } from './transforms';

export async function scanDirectories(
  resolvedIncludeDirs: string[],
  include: string[],
  exclude: string[]
): Promise<string[]> {
  const files: string[] = [];

  for (const dir of resolvedIncludeDirs) {
    try {
      await fs.access(dir);
    } catch (error) {
      console.warn(`Directory ${dir} does not exist, skipping...`);
      continue;
    }

    const patterns = include.map(pattern =>
      normalizePath(resolve(dir, pattern))
    );
    const negativePatterns = exclude.map(pattern =>
      `!${normalizePath(resolve(dir, pattern))}`
    );

    const matches = await fastGlob([...patterns, ...negativePatterns], {
      absolute: true,
      dot: true,
      followSymbolicLinks: false,
      onlyFiles: true,
      unique: true,
      cwd: process.cwd()
    });

    files.push(...matches.map(f => normalizePath(f)));
  }

  return files;
}

export async function scanForFunctions(
  resolvedIncludeDirs: string[],
  include: string[],
  exclude: string[]
) {
  const files = await scanDirectories(resolvedIncludeDirs, include, exclude);
  const exportedFunctions = [];
  const discoveredEnvVars = new Set<string>();

  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const relativePath = normalizePath(file).replace(process.cwd() + '/', '');
      const { exports, envVars, transformedContent } = parseFile(content, relativePath);

      if (envVars.length > 0) {
        const transformed = transformEnvImports(transformedContent);
        envVars.forEach(v => discoveredEnvVars.add(v));
      }

      exportedFunctions.push(...exports);
    } catch (error) {
      console.warn(`Error processing file ${file}: `, error);
    }
  }

  return { exportedFunctions, discoveredEnvVars };
}

export function generateEntryModule(
  exportedFunctions: any[],
  discoveredEnvVars: Set<string>
) {
  const envVars = [...discoveredEnvVars];

  return `
// Generated by triggerkit
${envVars.length > 0 ? `const { ${envVars.join(', ')} } = process.env;\n` : ''}

// Re-export transformed functions grouped by module
${Object.entries(exportedFunctions.reduce((acc, func) => {
    const importPath = func.path.replace(/^src\/lib\//, '$lib/').replace(/\.ts$/, '');

    if (!acc[importPath]) acc[importPath] = [];
    acc[importPath].push(func.exportName);
    return acc;
  }, {} as Record<string, string[]>))
      .map(([path, exports]) => `export { ${exports.join(', ')} } from '${path}';`)
      .join('\n')}

// Export function metadata
export const functions = ${JSON.stringify(
        exportedFunctions.reduce((acc, func) => ({
          ...acc,
          [func.name]: {
            metadata: func.metadata,
            path: func.path,
            envVars: [...discoveredEnvVars]
          }
        }), {}),
        null,
        2
      )} as const;`;
}