import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * pi 1.4.0 只应用 truthy 的自定义 section，空字符串会回落到默认 docs 正文。
 * 使用单个空格覆盖文档索引，最终 <docs> 正文 trim() 后为空，同时保留段落结构。
 */
export const EMPTY_DOCS_SECTION_CONTENT = " ";

export function applyEmptyDocsSection(sections: Record<string, string>): void {
  sections.docs = EMPTY_DOCS_SECTION_CONTENT;
}

/** 仅覆盖 docs 正文；不改变 preamble、tools、rules、addendum、cwd 或工具声明。 */
export function createEmptyDocsExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      applyEmptyDocsSection(event.systemPromptOptions.sections);
    });
  };
}
