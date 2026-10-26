import { useId, useState } from 'react';

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
    <button className="folder-row" aria-expanded={expanded} aria-controls={childrenId} onClick={() => setExpanded(!expanded)} title={node.path}>
      <span className="disclosure" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
      <svg className="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4V3h5l1.5 2h6.5v8h-13Z" /></svg>
      <span className="file-name">{node.name}</span>
    </button>
    <div id={childrenId} hidden={!expanded}><Entries nodes={node.children!} selected={selected} open={open} /></div>
  </li>;
}

function Entries({ nodes, selected, open }: { nodes: Map<string, TreeNode> } & Omit<FileTreeProps, 'paths'>) {
  const sorted = [...nodes.values()].sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
  return <ul>{sorted.map(node => node.children
    ? <Folder key={node.path} node={node} selected={selected} open={open} />
    : <li key={node.path}><button className={`file-row ${selected === node.path ? 'selected' : ''}`} aria-current={selected === node.path ? 'page' : undefined} onClick={() => open(node.path)} title={node.path}>
      <span className="file-icon" aria-hidden="true">{node.name.endsWith('.bal') ? 'B' : '≡'}</span><span className="file-name">{node.name}</span>
    </button></li>)}</ul>;
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
  return <nav className="file-tree" aria-label="Workspace files"><Entries nodes={root} selected={selected} open={open} /></nav>;
}
