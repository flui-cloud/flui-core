import { Injectable } from '@nestjs/common';
import {
  TemplateContext,
  TemplateComponentContext,
} from '../interfaces/template-context.interface';

const EXPR_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;

export class TemplateResolutionError extends Error {
  constructor(
    public readonly path: string,
    public readonly input: string,
  ) {
    super(
      `Template path "${path}" could not be resolved in expression "${input}"`,
    );
    this.name = 'TemplateResolutionError';
  }
}

@Injectable()
export class CatalogTemplateResolverService {
  resolve(input: string, ctx: TemplateContext): string {
    return input.replaceAll(EXPR_REGEX, (_match, rawPath: string) => {
      const path = rawPath.trim();
      const value = this.lookup(path, ctx);
      if (value === undefined) {
        throw new TemplateResolutionError(path, input);
      }
      return value;
    });
  }

  resolveArray(inputs: string[], ctx: TemplateContext): string[] {
    return inputs.map((s) => this.resolve(s, ctx));
  }

  private lookup(path: string, ctx: TemplateContext): string | undefined {
    const parts = path.split('.');
    const root = parts[0];

    if (root === 'app') {
      return this.lookupApp(parts.slice(1), ctx);
    }
    if (root === 'env') {
      const varName = parts[1];
      return ctx.env[varName];
    }
    if (root === 'components') {
      return this.lookupComponents(parts.slice(1), ctx);
    }
    if (root === 'self') {
      return ctx.self
        ? this.lookupComponentFields(parts.slice(1), ctx.self)
        : undefined;
    }
    if (root === 'deps') {
      return this.lookupDeps(parts.slice(1), ctx);
    }
    return undefined;
  }

  private lookupComponentFields(
    parts: string[],
    component: TemplateComponentContext,
  ): string | undefined {
    const [field, ...rest] = parts;
    if (field === 'host') return component.host;
    if (field === 'fqdn') return component.fqdn;
    if (field === 'env') return component.env[rest[0]];
    return undefined;
  }

  private lookupApp(parts: string[], ctx: TemplateContext): string | undefined {
    const key = parts[0];
    if (key === 'id') return ctx.app.id;
    if (key === 'slug') return ctx.app.slug;
    if (key === 'domain') return ctx.app.domain;
    if (key === 'namespace') return ctx.app.namespace;
    return undefined;
  }

  private lookupComponents(
    parts: string[],
    ctx: TemplateContext,
  ): string | undefined {
    if (!ctx.components) return undefined;
    const [componentName, ...fieldParts] = parts;
    const component = ctx.components[componentName];
    if (!component) return undefined;
    return this.lookupComponentFields(fieldParts, component);
  }

  private lookupDeps(
    parts: string[],
    ctx: TemplateContext,
  ): string | undefined {
    if (!ctx.deps) return undefined;
    const [alias, field, ...rest] = parts;
    const dep = ctx.deps[alias];
    if (!dep) return undefined;
    if (field === 'host') return dep.host;
    if (field === 'port')
      return dep.port === undefined ? undefined : String(dep.port);
    if (field === 'env') {
      const varName = rest[0];
      return dep.env[varName];
    }
    return undefined;
  }
}
