import React, { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { Copy, Check } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import 'katex/dist/katex.min.css';

interface CodeHeaderProps {
  language?: string;
  code: string;
}

const useCopyToClipboard = ({ copiedDuration = 3000 }: { copiedDuration?: number } = {}) => {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const CodeHeader: React.FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className="flex items-center justify-between bg-zinc-900 px-4 py-2 rounded-t-lg">
      <span className="text-sm font-semibold text-white lowercase">{language}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-white hover:bg-zinc-800"
        onClick={() => copyToClipboard(code)}
      >
        {isCopied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
};

const defaultComponents: any = {
  h1: ({ className, ...props }: { className?: string }) => (
    <h1 className="mb-4 scroll-m-20 text-3xl font-bold tracking-tight first:mt-0" {...props} />
  ),
  h2: ({ className, ...props }: { className?: string }) => (
    <h2 className="mb-3 mt-6 scroll-m-20 text-2xl font-semibold tracking-tight first:mt-0" {...props} />
  ),
  h3: ({ className, ...props }: { className?: string }) => (
    <h3 className="mb-2 mt-4 scroll-m-20 text-xl font-semibold tracking-tight first:mt-0" {...props} />
  ),
  h4: ({ className, ...props }: { className?: string }) => (
    <h4 className="mb-2 mt-4 scroll-m-20 text-lg font-semibold tracking-tight first:mt-0" {...props} />
  ),
  p: ({ className, ...props }: { className?: string }) => (
    <p className="mb-4 leading-7 first:mt-0 last:mb-0" {...props} />
  ),
  a: ({ className, ...props }: { className?: string }) => (
    <a className="text-primary font-medium underline underline-offset-4 hover:text-primary/80" {...props} />
  ),
  blockquote: ({ className, ...props }: { className?: string }) => (
    <blockquote className="border-l-2 border-primary pl-4 italic my-4" {...props} />
  ),
  ul: ({ className, ...props }: { className?: string }) => (
    <ul className="my-4 ml-6 list-disc [&>li]:mt-2" {...props} />
  ),
  ol: ({ className, ...props }: { className?: string }) => (
    <ol className="my-4 ml-6 list-decimal [&>li]:mt-2" {...props} />
  ),
  hr: ({ className, ...props }: { className?: string }) => (
    <hr className="my-6 border-border" {...props} />
  ),
  table: ({ className, ...props }: { className?: string }) => (
    <div className="my-4 w-full overflow-x-auto">
      <table className="w-full border-collapse" {...props} />
    </div>
  ),
  th: ({ className, ...props }: { className?: string }) => (
    <th className="border border-border bg-muted px-4 py-2 text-left font-bold" {...props} />
  ),
  td: ({ className, ...props }: { className?: string }) => (
    <td className="border border-border px-4 py-2 text-left" {...props} />
  ),
  pre: ({ className, ...props }: { className?: string }) => (
    <pre className="overflow-x-auto rounded-lg my-4" {...props} />
  ),
  code: ({ className, children, ...props }: { className?: string; children: React.ReactNode }) => {
    const match = /language-(\w+)/.exec(className || '');

    if (match) {
      const language = match[1];
      const code = String(children).replace(/\n$/, '');

      return (
        <div className="my-4">
          <CodeHeader language={language} code={code} />
          <SyntaxHighlighter
            language={language}
            style={oneDark}
            customStyle={{
              margin: 0,
              borderTopLeftRadius: 0,
              borderTopRightRadius: 0,
              borderBottomLeftRadius: '0.5rem',
              borderBottomRightRadius: '0.5rem',
            }}
          >
            {code}
          </SyntaxHighlighter>
        </div>
      );
    }

    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm" {...props}>
        {children}
      </code>
    );
  },
};

interface MarkdownTextProps {
  children: string;
}

const MarkdownTextImpl: React.FC<MarkdownTextProps> = ({ children }) => {
  return (
    <div className="markdown-content prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={defaultComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
