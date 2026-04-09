#!/usr/bin/env npx tsx
/**
 * Benchmark PDF providers: unpdf vs kreuzberg
 *
 * Compares memory usage, speed, and output quality for different PDF sizes.
 *
 * Usage: npx tsx scripts/benchmark-providers.ts [pdf-path]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPDFReader } from '../src/index.js';

const testPdfs = [
  // Small PDF (~100KB)
  resolve(
    import.meta.dirname,
    '../test/Signed-Meeting-Minutes-July-9-2024-Regular-Meeting-of-Council.pdf',
  ),
  // Medium PDF (~9MB)
  resolve(
    import.meta.dirname,
    '../test/Agenda-Package-August-27-2024-Regular-Council-Meeting.pdf',
  ),
];

type Provider = 'unpdf' | 'kreuzberg';

interface BenchmarkResult {
  provider: Provider;
  file: string;
  fileSize: string;
  duration: number;
  memoryUsedMB: number;
  peakMemoryMB: number;
  textLength: number;
  success: boolean;
  error?: string;
}

async function measureMemory(): Promise<number> {
  if (global.gc) {
    global.gc();
  }
  await new Promise((r) => setTimeout(r, 100));
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

async function benchmarkProvider(
  provider: Provider,
  pdfPath: string,
): Promise<BenchmarkResult> {
  const fileName = pdfPath.split('/').pop() || pdfPath;
  const fileSize = existsSync(pdfPath)
    ? `${(readFileSync(pdfPath).length / 1024 / 1024).toFixed(2)}MB`
    : 'N/A';

  console.log(`\n  Testing ${provider} on ${fileName} (${fileSize})...`);

  const startMemory = await measureMemory();
  let peakMemory = startMemory;
  const startTime = performance.now();

  try {
    const reader = await getPDFReader({ provider });
    const text = await reader.extractText(pdfPath);

    // Check peak memory
    const currentMemory = await measureMemory();
    peakMemory = Math.max(peakMemory, currentMemory);

    const duration = performance.now() - startTime;
    const memoryUsed = currentMemory - startMemory;

    return {
      provider,
      file: fileName,
      fileSize,
      duration: Math.round(duration),
      memoryUsedMB: Math.round(memoryUsed * 100) / 100,
      peakMemoryMB: Math.round(peakMemory * 100) / 100,
      textLength: text?.length || 0,
      success: true,
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    return {
      provider,
      file: fileName,
      fileSize,
      duration: Math.round(duration),
      memoryUsedMB: 0,
      peakMemoryMB: peakMemory,
      textLength: 0,
      success: false,
      error: (error as Error).message,
    };
  }
}

async function runBenchmarks(pdfPaths: string[]) {
  console.log('='.repeat(70));
  console.log('PDF Provider Benchmark: unpdf vs kreuzberg');
  console.log('='.repeat(70));

  const results: BenchmarkResult[] = [];
  const providers: Provider[] = ['unpdf', 'kreuzberg'];

  for (const pdfPath of pdfPaths) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`File: ${pdfPath.split('/').pop()}`);

    for (const provider of providers) {
      const result = await benchmarkProvider(provider, pdfPath);
      results.push(result);

      if (result.success) {
        console.log(`    Duration: ${result.duration}ms`);
        console.log(
          `    Memory: +${result.memoryUsedMB}MB (peak: ${result.peakMemoryMB}MB)`,
        );
        console.log(
          `    Text extracted: ${result.textLength.toLocaleString()} chars`,
        );
      } else {
        console.log(`    FAILED: ${result.error}`);
      }
    }
  }

  // Summary table
  console.log(`\n${'='.repeat(70)}`);
  console.log('Summary');
  console.log('='.repeat(70));

  console.log('\n| File | Provider | Duration | Memory | Text Length |');
  console.log('|------|----------|----------|--------|-------------|');

  for (const r of results) {
    const status = r.success ? '' : ' [FAILED]';
    console.log(
      `| ${r.file.slice(0, 30)}... | ${r.provider.padEnd(10)} | ${String(r.duration).padStart(6)}ms | ${String(r.memoryUsedMB).padStart(6)}MB | ${r.textLength.toLocaleString().padStart(11)} |${status}`,
    );
  }

  // Compare by file
  console.log('\n\nComparison by file:');
  const byFile = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    const existing = byFile.get(r.file) || [];
    existing.push(r);
    byFile.set(r.file, existing);
  }

  for (const [file, fileResults] of byFile) {
    const unpdf = fileResults.find((r) => r.provider === 'unpdf');
    const kreuzberg = fileResults.find((r) => r.provider === 'kreuzberg');

    if (unpdf?.success && kreuzberg?.success) {
      const speedDiff = (
        ((unpdf.duration - kreuzberg.duration) / unpdf.duration) *
        100
      ).toFixed(1);
      const memDiff = (
        ((unpdf.memoryUsedMB - kreuzberg.memoryUsedMB) /
          (unpdf.memoryUsedMB || 1)) *
        100
      ).toFixed(1);

      console.log(`\n  ${file}:`);
      console.log(
        `    Speed: kreuzberg is ${Number(speedDiff) > 0 ? `${speedDiff}% faster` : `${Math.abs(Number(speedDiff))}% slower`}`,
      );
      console.log(
        `    Memory: kreuzberg uses ${Number(memDiff) > 0 ? `${memDiff}% less` : `${Math.abs(Number(memDiff))}% more`}`,
      );
    }
  }
}

// Main
const customPdf = process.argv[2];
const pdfsToTest = customPdf
  ? [resolve(customPdf)]
  : testPdfs.filter(existsSync);

if (pdfsToTest.length === 0) {
  console.error(
    'No test PDFs found. Provide a PDF path or ensure test PDFs exist.',
  );
  process.exit(1);
}

runBenchmarks(pdfsToTest).catch(console.error);
