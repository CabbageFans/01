import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 加载产品真实隐藏规则；不展开折叠、不强制显示节点。其余样式由组件实际渲染。
const productCss = fs.readFileSync(path.join(process.cwd(), 'src/styles/global.css'), 'utf8');
const hiddenRule = productCss.match(/\.page-hidden\s*\{[^}]+\}/)?.[0];
if (!hiddenRule) throw new Error('产品隐藏页面样式缺失');
const style = document.createElement('style'); style.textContent = hiddenRule; document.head.append(style);
if (!window.matchMedia) window.matchMedia = (query: string): MediaQueryList => ({ matches: false, media: query, onchange: null, addListener: (): void => undefined, removeListener: (): void => undefined, addEventListener: (): void => undefined, removeEventListener: (): void => undefined, dispatchEvent: (): boolean => false });
Element.prototype.scrollIntoView = (): void => undefined;
afterEach((): void => cleanup());
