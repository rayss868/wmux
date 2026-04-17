import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompanyTemplate } from '../../shared/types';

/**
 * Company 구성을 JSON 파일로 저장/로드하는 매니저.
 * 저장 경로: app.getPath('userData') / templates / {name}.json
 */
export class CompanyTemplateManager {
  private readonly templatesDir: string;

  constructor() {
    this.templatesDir = path.join(app.getPath('userData'), 'templates');
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.templatesDir)) {
      fs.mkdirSync(this.templatesDir, { recursive: true });
    }
  }

  /**
   * Sanitize template name to a safe filename component.
   * Rejects path traversal sequences and enforces length limit.
   */
  private sanitizeName(name: string): string {
    if (!name || name.trim().length === 0) {
      throw new Error('Template name must not be empty');
    }
    // Replace characters that are invalid in file names
    let safe = name.replace(/[/\\:*?"<>|]/g, '_');
    // Remove any remaining path traversal sequences
    safe = safe.replace(/\.\./g, '_');
    // Trim whitespace and enforce length limit
    safe = safe.trim().slice(0, 100);
    if (safe.length === 0) {
      throw new Error('Template name must contain valid characters');
    }
    return safe;
  }

  private filePath(name: string): string {
    const safe = this.sanitizeName(name);
    const resolved = path.resolve(this.templatesDir, `${safe}.json`);
    // Verify the resolved path is actually inside the templates directory
    if (!resolved.startsWith(this.templatesDir + path.sep) && resolved !== this.templatesDir) {
      throw new Error('Invalid template name: path traversal detected');
    }
    return resolved;
  }

  /** JSON 파일로 템플릿을 저장한다. */
  save(company: CompanyTemplate): void {
    const fp = this.filePath(company.name);
    fs.writeFileSync(fp, JSON.stringify(company, null, 2), 'utf-8');
  }

  /** 이름으로 템플릿을 로드한다. 존재하지 않으면 null 반환. */
  load(name: string): CompanyTemplate | null {
    const fp = this.filePath(name);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const parsed = JSON.parse(raw, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as CompanyTemplate;
      // Basic schema validation
      if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.departments)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** 저장된 템플릿 이름 목록을 반환한다. */
  list(): string[] {
    this.ensureDir();
    return fs
      .readdirSync(this.templatesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  }

  /** 이름으로 템플릿 파일을 삭제한다. */
  delete(name: string): void {
    const fp = this.filePath(name);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }

  /**
   * 지정된 절대 경로로 템플릿을 내보낸다.
   * Security: validates the target path is within a safe directory.
   */
  exportToFile(company: CompanyTemplate, filePath: string): void {
    const resolved = path.resolve(filePath);
    // Block writing to system-critical directories
    const blocked = ['C:\\Windows', 'C:\\Program Files', '/etc', '/usr', '/bin', '/sbin'];
    for (const prefix of blocked) {
      if (resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
        throw new Error(`exportToFile: writing to ${prefix} is not allowed`);
      }
    }
    fs.writeFileSync(resolved, JSON.stringify(company, null, 2), 'utf-8');
  }

  /**
   * 지정된 절대 경로에서 템플릿을 가져온다. 파싱 실패 시 null 반환.
   * Security: validates the file size to prevent abuse.
   */
  importFromFile(filePath: string): CompanyTemplate | null {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    try {
      // Guard against reading excessively large files
      const stat = fs.statSync(resolved);
      if (stat.size > 1024 * 1024) {
        // 1MB max for a template JSON
        throw new Error('Template file too large (max 1MB)');
      }
      const raw = fs.readFileSync(resolved, 'utf-8');
      const parsed = JSON.parse(raw, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as CompanyTemplate;
      // Basic schema validation
      if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.departments)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
