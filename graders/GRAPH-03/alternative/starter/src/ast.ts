export interface AstNode {
  readonly type: string;
  readonly children?: readonly AstNode[];
}

export class DepthExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super('AST 深度超过允许上限 ' + limit);
    this.name = 'DepthExceededError';
    this.limit = limit;
  }
}

export class InvalidNodeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('AST 节点非法：' + path);
    this.name = 'InvalidNodeError';
    this.path = path;
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** 校验并返回子节点；缺省 children 与空数组等价，非法结构抛出带路径的 InvalidNodeError。 */
function childrenOf(node: AstNode, path: string): readonly AstNode[] {
  const children = node.children;
  if (children === undefined) return [];
  if (!Array.isArray(children)) throw new InvalidNodeError(path + '.children');
  for (let index = 0; index < children.length; index += 1) {
    if (!isNode(children[index])) throw new InvalidNodeError(path + '.children[' + index + ']');
  }
  return children;
}

function assertRoot(root: AstNode): void {
  if (!isNode(root)) throw new InvalidNodeError('root');
}

/** 替代实现：双栈后序 + 队列式前序 + BFS 深度，写法与参考实现完全不同。 */
export function walkPostOrder(root: AstNode, visit: (node: AstNode) => void): number {
  assertRoot(root);
  const pending: Array<{ node: AstNode; path: string }> = [{ node: root, path: 'root' }];
  const reversed: AstNode[] = [];
  while (pending.length > 0) {
    const current = pending.pop() as { node: AstNode; path: string };
    reversed.push(current.node);
    const children = childrenOf(current.node, current.path);
    for (let index = 0; index < children.length; index += 1) {
      pending.push({ node: children[index] as AstNode, path: current.path + '.children[' + index + ']' });
    }
  }
  for (let index = reversed.length - 1; index >= 0; index -= 1) visit(reversed[index] as AstNode);
  return reversed.length;
}

export function flattenPreOrder(root: AstNode): string[] {
  assertRoot(root);
  interface Frame { node: AstNode; path: string; children: readonly AstNode[]; index: number }
  const types: string[] = [];
  const stack: Frame[] = [{ node: root, path: 'root', children: childrenOf(root, 'root'), index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index === 0) types.push(frame.node.type);
    if (frame.index < frame.children.length) {
      const index = frame.index;
      frame.index = index + 1;
      const child = frame.children[index] as AstNode;
      const path = frame.path + '.children[' + index + ']';
      stack.push({ node: child, path, children: childrenOf(child, path), index: 0 });
      continue;
    }
    stack.pop();
  }
  return types;
}

export function maxDepth(root: AstNode, limit: number): number {
  assertRoot(root);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit 必须是大于等于 1 的整数');
  let level: Array<{ node: AstNode; path: string }> = [{ node: root, path: 'root' }];
  let depth = 0;
  while (level.length > 0) {
    depth += 1;
    if (depth > limit) throw new DepthExceededError(limit);
    const next: Array<{ node: AstNode; path: string }> = [];
    for (const current of level) {
      const children = childrenOf(current.node, current.path);
      for (let index = 0; index < children.length; index += 1) {
        next.push({ node: children[index] as AstNode, path: current.path + '.children[' + index + ']' });
      }
    }
    level = next;
  }
  return depth;
}

