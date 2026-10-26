import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';

interface TreeNode {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
}

interface FileTreeProps {
  paths: string[];
  selected: string | null;
  open: (path: string) => void;
}

function Folder({ node, selected, open }: { node: TreeNode } & Omit<FileTreeProps, 'paths'>) {
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  return <li>
    <Button variant="ghost" size="sm" className="folder-row w-full min-w-max justify-start gap-2 text-muted-foreground" aria-expanded={expanded} aria-controls={childrenId} onClick={() => setExpanded(!expanded)} title={node.path}>
      <span className="disclosure w-3" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
      <svg className="folder-icon size-3.5 flex-none fill-none stroke-current" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4V3h5l1.5 2h6.5v8h-13Z" /></svg>
      <span className="file-name">{node.name}</span>
    </Button>
    <div id={childrenId} className="ml-4 border-l pl-1.5" hidden={!expanded}><Entries nodes={node.children!} selected={selected} open={open} /></div>
  </li>;
}

function Entries({ nodes, selected, open }: { nodes: Map<string, TreeNode> } & Omit<FileTreeProps, 'paths'>) {
  const sorted = [...nodes.values()].sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
  return <ul className="m-0 list-none p-0">{sorted.map(node => node.children
    ? <Folder key={node.path} node={node} selected={selected} open={open} />
    : <li key={node.path}><Button variant="ghost" size="sm" className={`file-row w-full min-w-max justify-start gap-2 pl-5 ${selected === node.path ? 'selected bg-accent text-accent-foreground' : ''}`} aria-current={selected === node.path ? 'page' : undefined} onClick={() => open(node.path)} title={node.path}>
      <span className="file-icon w-3 flex-none font-mono text-[11px] text-muted-foreground" aria-hidden="true">{node.name.endsWith('.bal') ? 'B' : '≡'}</span><span className="file-name">{node.name}</span>
    </Button></li>)}</ul>;
}

export function FileTree({ paths, selected, open }: FileTreeProps) {
  const root = new Map<string, TreeNode>();
  for (const path of paths) {
    const parts = path.split('/');
    let siblings = root;
    parts.forEach((name, index) => {
      if (!siblings.has(name)) siblings.set(name, {
        name,
        path: parts.slice(0, index + 1).join('/'),
        ...(index < parts.length - 1 ? { children: new Map<string, TreeNode>() } : {}),
      });
      const node = siblings.get(name)!;
      if (node.children) siblings = node.children;
    });
  }
  return <nav className="file-tree flex-none overflow-x-auto" aria-label="Workspace files"><Entries nodes={root} selected={selected} open={open} /></nav>;
}
