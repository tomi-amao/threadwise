import { marked } from 'marked';
import { useEffect, useState } from 'react';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * MarkdownRenderer Component
 *
 * Renders markdown content with custom styling optimized for the ThreadWise chat interface.
 * Supports code blocks, headers, lists, links, and other common markdown elements.
 */
export default function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    const renderMarkdown = async () => {
      try {
        // Configure marked with custom renderer for better styling
        marked.setOptions({
          gfm: true, // GitHub Flavored Markdown
          breaks: true, // Convert \n to <br>
        });

        // Custom renderer for code blocks and inline code
        const renderer = new marked.Renderer();

        // Custom code block rendering
        renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
          const language = lang || 'text';
          return `
            <div class="code-block-wrapper">
              <div class="code-block-header">
                <span class="code-language">${language}</span>
                <button class="copy-button" onclick="navigator.clipboard.writeText(\`${text.replace(/`/g, '\\`')}\`)">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                  </svg>
                </button>
              </div>
              <pre><code class="language-${language}">${text}</code></pre>
            </div>
          `;
        };

        // Custom inline code rendering
        renderer.codespan = ({ text }: { text: string }) => {
          return `<code class="inline-code">${text}</code>`;
        };

        // Custom link rendering (open in new tab for external links)
        interface SimpleToken {
          raw?: string;
          text?: string;
        }

        interface LinkRendererParams {
          href: string;
          title?: string | null;
          tokens: SimpleToken[];
        }

        renderer.link = ({ href, title, tokens }: LinkRendererParams): string => {
          const text = tokens.map(token => token.raw || token.text || '').join('');
          const isExternal = href?.startsWith('http') || href?.startsWith('//');
          const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
          const titleAttr = title ? ` title="${title}"` : '';
          return `<a href="${href}"${target}${titleAttr} class="markdown-link">${text}</a>`;
        };

        // Set the custom renderer
        marked.setOptions({ renderer });

        const html = await marked(content);
        setHtmlContent(html);
      } catch (error) {
        console.error('Error rendering markdown:', error);
        setHtmlContent(
          `<p class="error">Error rendering markdown: ${error instanceof Error ? error.message : 'Unknown error'}</p>`
        );
      }
    };

    renderMarkdown();
  }, [content]);

  return (
    <div
      className={`markdown-content ${className}`}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
      style={
        {
          // Custom CSS-in-JS for markdown elements
          '--code-bg': 'rgb(243 244 246)',
          '--code-bg-dark': 'rgb(55 65 81)',
          '--code-text': 'rgb(31 41 55)',
          '--code-text-dark': 'rgb(243 244 246)',
          '--border-color': 'rgb(229 231 235)',
          '--border-color-dark': 'rgb(75 85 99)',
        } as React.CSSProperties
      }
    />
  );
}

// Add global styles (these would typically be in a CSS file)
const markdownStyles = `
  .markdown-content {
    line-height: 1.6;
    color: inherit;
  }

  .markdown-content h1,
  .markdown-content h2,
  .markdown-content h3,
  .markdown-content h4,
  .markdown-content h5,
  .markdown-content h6 {
    font-weight: 600;
    margin: 1.5em 0 0.5em 0;
    line-height: 1.3;
  }

  .markdown-content h1 { font-size: 1.5em; }
  .markdown-content h2 { font-size: 1.3em; }
  .markdown-content h3 { font-size: 1.1em; }
  
  .markdown-content p {
    margin: 0.75em 0;
  }

  .markdown-content ul,
  .markdown-content ol {
    margin: 0.75em 0;
    padding-left: 1.5em;
  }

  .markdown-content li {
    margin: 0.25em 0;
  }

  .markdown-content strong {
    font-weight: 600;
  }

  .markdown-content em {
    font-style: italic;
  }

  .markdown-content blockquote {
    border-left: 3px solid var(--border-color);
    margin: 1em 0;
    padding: 0.5em 1em;
    background: rgba(0, 0, 0, 0.02);
    font-style: italic;
  }

  .dark .markdown-content blockquote {
    border-color: var(--border-color-dark);
    background: rgba(255, 255, 255, 0.05);
  }

  .markdown-content .inline-code {
    background: var(--code-bg);
    color: var(--code-text);
    padding: 0.125em 0.25em;
    border-radius: 0.25em;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.875em;
  }

  .dark .markdown-content .inline-code {
    background: var(--code-bg-dark);
    color: var(--code-text-dark);
  }

  .markdown-content .code-block-wrapper {
    margin: 1em 0;
    border-radius: 0.5em;
    overflow: hidden;
    border: 1px solid var(--border-color);
  }

  .dark .markdown-content .code-block-wrapper {
    border-color: var(--border-color-dark);
  }

  .markdown-content .code-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5em 1em;
    background: var(--code-bg);
    border-bottom: 1px solid var(--border-color);
    font-size: 0.75em;
    font-weight: 500;
  }

  .dark .markdown-content .code-block-header {
    background: var(--code-bg-dark);
    border-color: var(--border-color-dark);
  }

  .markdown-content .code-language {
    color: var(--code-text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dark .markdown-content .code-language {
    color: var(--code-text-dark);
  }

  .markdown-content .copy-button {
    background: none;
    border: none;
    color: var(--code-text);
    cursor: pointer;
    padding: 0.25em;
    border-radius: 0.25em;
    transition: background-color 0.2s;
  }

  .markdown-content .copy-button:hover {
    background: rgba(0, 0, 0, 0.1);
  }

  .dark .markdown-content .copy-button {
    color: var(--code-text-dark);
  }

  .dark .markdown-content .copy-button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .markdown-content pre {
    margin: 0;
    padding: 1em;
    background: var(--code-bg);
    overflow-x: auto;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.875em;
    line-height: 1.4;
  }

  .dark .markdown-content pre {
    background: var(--code-bg-dark);
  }

  .markdown-content pre code {
    color: var(--code-text);
    background: none;
    padding: 0;
    border-radius: 0;
  }

  .dark .markdown-content pre code {
    color: var(--code-text-dark);
  }

  .markdown-content .markdown-link {
    color: rgb(59 130 246);
    text-decoration: underline;
    text-decoration-color: rgba(59, 130, 246, 0.3);
    transition: text-decoration-color 0.2s;
  }

  .markdown-content .markdown-link:hover {
    text-decoration-color: rgb(59 130 246);
  }

  .dark .markdown-content .markdown-link {
    color: rgb(147 197 253);
  }

  .markdown-content .error {
    color: rgb(239 68 68);
    font-style: italic;
  }

  .dark .markdown-content .error {
    color: rgb(248 113 113);
  }
`;

// Inject styles into document head
if (typeof document !== 'undefined') {
  const existingStyle = document.getElementById('markdown-styles');
  if (!existingStyle) {
    const style = document.createElement('style');
    style.id = 'markdown-styles';
    style.textContent = markdownStyles;
    document.head.appendChild(style);
  }
}
