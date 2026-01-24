import { beforeEach, describe, expect, it } from 'vitest';
import { getPDFReader } from './index';
import type { PDFReader } from './shared/types';

describe('PDF Reader Capabilities and Dependencies', () => {
  let reader: PDFReader;

  beforeEach(async () => {
    reader = await getPDFReader();
  });

  it('should check PDF reader capabilities', async () => {
    const capabilities = await reader.checkCapabilities();

    expect(capabilities).toHaveProperty('canExtractText');
    expect(capabilities).toHaveProperty('canExtractMetadata');
    expect(capabilities).toHaveProperty('canExtractImages');
    expect(capabilities).toHaveProperty('canPerformOCR');
    expect(capabilities).toHaveProperty('supportedFormats');

    expect(typeof capabilities.canExtractText).toBe('boolean');
    expect(typeof capabilities.canExtractMetadata).toBe('boolean');
    expect(typeof capabilities.canExtractImages).toBe('boolean');
    expect(typeof capabilities.canPerformOCR).toBe('boolean');

    expect(Array.isArray(capabilities.supportedFormats)).toBe(true);
    expect(capabilities.supportedFormats).toContain('pdf');

    // Core capabilities should be available
    expect(capabilities.canExtractText).toBe(true);
    expect(capabilities.canExtractMetadata).toBe(true);
    // Note: canExtractImages is false for kreuzberg (OCR is integrated into extractText)
  });

  it('should check PDF reader dependencies', async () => {
    const dependencies = await reader.checkDependencies();

    expect(dependencies).toHaveProperty('available');
    expect(dependencies).toHaveProperty('details');
    expect(typeof dependencies.available).toBe('boolean');
    expect(typeof dependencies.details).toBe('object');

    // Details should have provider-specific keys (kreuzberg or unpdf)
    const hasProviderKey =
      'kreuzberg' in dependencies.details || 'unpdf' in dependencies.details;
    expect(hasProviderKey).toBe(true);
  });

  it('should report consistent capabilities across multiple calls', async () => {
    const caps1 = await reader.checkCapabilities();
    const caps2 = await reader.checkCapabilities();

    expect(caps1.canExtractText).toBe(caps2.canExtractText);
    expect(caps1.canExtractMetadata).toBe(caps2.canExtractMetadata);
    expect(caps1.canExtractImages).toBe(caps2.canExtractImages);
    expect(caps1.canPerformOCR).toBe(caps2.canPerformOCR);
    expect(caps1.supportedFormats).toEqual(caps2.supportedFormats);
  });

  it('should report dependency status consistently', async () => {
    const deps1 = await reader.checkDependencies();
    const deps2 = await reader.checkDependencies();

    expect(deps1.available).toBe(deps2.available);

    // Details should be consistent across calls
    expect(deps1.details).toEqual(deps2.details);
  });

  it('should validate capabilities structure', async () => {
    const capabilities = await reader.checkCapabilities();

    // Required properties
    expect(capabilities).toHaveProperty('canExtractText');
    expect(capabilities).toHaveProperty('canExtractMetadata');
    expect(capabilities).toHaveProperty('canExtractImages');
    expect(capabilities).toHaveProperty('canPerformOCR');
    expect(capabilities).toHaveProperty('supportedFormats');

    // Optional properties can be undefined but if present should have correct types
    if (capabilities.maxFileSize !== undefined) {
      expect(typeof capabilities.maxFileSize).toBe('number');
      expect(capabilities.maxFileSize).toBeGreaterThan(0);
    }

    if (capabilities.ocrLanguages !== undefined) {
      expect(Array.isArray(capabilities.ocrLanguages)).toBe(true);
    }
  });

  it('should validate dependency check structure', async () => {
    const dependencies = await reader.checkDependencies();

    // Required properties
    expect(dependencies).toHaveProperty('available');
    expect(dependencies).toHaveProperty('details');
    expect(typeof dependencies.available).toBe('boolean');
    expect(typeof dependencies.details).toBe('object');
    expect(dependencies.details).not.toBeNull();

    // Error property should exist if not available
    if (!dependencies.available) {
      expect(dependencies).toHaveProperty('error');
      expect(typeof dependencies.error).toBe('string');
      expect(dependencies.error?.length).toBeGreaterThan(0);
    }
  });
});
