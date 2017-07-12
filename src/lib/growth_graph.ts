import {SnapshotEdgeType, SnapshotNodeType} from '../common/interfaces';

export const enum NodeFlag {
  VisitBit = 1 << 31,
  Growing = 1 << 30,
  New = 1 << 29,
  // Maximum value of data in the 32-bit field.
  DataMask = ~(NodeFlag.VisitBit | NodeFlag.Growing | NodeFlag.New)
}

export type Edge = NamedEdge | IndexEdge | ClosureEdge;

function isHidden(type: SnapshotEdgeType): boolean {
  switch(type) {
    case SnapshotEdgeType.Internal:
    case SnapshotEdgeType.Hidden:
    case SnapshotEdgeType.Shortcut:
      return true;
    default:
      return false;
  }
}

function shouldTraverse(edge: Edge): boolean {
  // HACK: Ignore <symbol> properties. There may be multiple properties
  // with the name <symbol> in a heap snapshot. There does not appear to
  // be an easy way to disambiguate them.
  if (edge.indexOrName === "<symbol>") {
    return false;
  }
  if (edge.snapshotType === SnapshotEdgeType.Internal) {
    // Whitelist of internal edges we know how to follow.
    switch (edge.indexOrName) {
      case "elements":
      case "table":
      case "properties":
      case "context":
        return true;
      default:
        return `${edge.indexOrName}`.startsWith("Document");
    }
  }
  return true;
}

function serializeEdge(e: Edge): SerializeableEdge {
  return {
    type: e.type,
    indexOrName: e.indexOrName
  };
}

/**
 * Named property, e.g. obj['foo']
 */
export class NamedEdge {
  public readonly indexOrName: string;
  public to: Node;
  public snapshotType: SnapshotEdgeType;
  constructor(name: string, to: Node, type: SnapshotEdgeType) {
    this.indexOrName = name;
    this.to = to;
    this.snapshotType = type;
  }
  public get type(): EdgeType.NAMED {
    return EdgeType.NAMED;
  }
  public toJSON(): SerializeableEdge {
    return serializeEdge(this);
  }
}

/**
 * Numerical index property, e.g. obj[1]
 */
export class IndexEdge {
  public readonly indexOrName: number;
  public to: Node;
  public snapshotType: SnapshotEdgeType;
  constructor(indexOrName: number, to: Node, type: SnapshotEdgeType) {
    this.indexOrName = indexOrName;
    this.to = to;
    this.snapshotType = type;
  }
  public get type(): EdgeType.INDEX {
    return EdgeType.INDEX;
  }
  public toJSON(): SerializeableEdge {
    return serializeEdge(this);
  }
}

/**
 * Function closure, e.g.
 * var a; function foo() { return a; }
 * ^ foo's closure contains 'a'.
 */
export class ClosureEdge {
  public readonly indexOrName: string;
  public to: Node;
  public snapshotType: SnapshotEdgeType;
  constructor(name: string, to: Node, type: SnapshotEdgeType) {
    this.indexOrName = name;
    this.to = to;
    this.snapshotType = type;
  }
  public get type(): EdgeType.CLOSURE {
    return EdgeType.CLOSURE;
  }
  public toJSON(): SerializeableEdge {
    return serializeEdge(this);
  }
}

function MakeEdge(edgeType: SnapshotEdgeType, nameOrIndex: number, toNode: Node, lookupString: (id: number) => string): Edge | null {
  switch (edgeType) {
    case SnapshotEdgeType.Element: // Array element.
    case SnapshotEdgeType.Hidden: // Hidden from developer, but influences in-memory size. Apparently has an index, not a name. Ignore for now.
      return new IndexEdge(nameOrIndex, toNode, edgeType);
    case SnapshotEdgeType.ContextVariable: // Function context. I think it has a name, like "context".
      return new ClosureEdge(lookupString(nameOrIndex), toNode, edgeType);
    case SnapshotEdgeType.Internal: // Internal data structures that are not actionable to developers. Influence retained size. Ignore for now.
    case SnapshotEdgeType.Shortcut: // Shortcut: Should be ignored; an internal detail.
    case SnapshotEdgeType.Weak: // Weak reference: Doesn't hold onto memory.
    case SnapshotEdgeType.Property: // Property on an object.
      return new NamedEdge(lookupString(nameOrIndex), toNode, edgeType);
    // The remaining types cannot be observed at the program-level, and are not actionable to us.
    // Our runtime agent will "lift" some of this state into actionable state.
    default: // Who knows?
      // console.log(`Unknown edge type ${edgeType}`);
      return null;
  }
}

/**
 * Node class that forms the heap graph.
 */
export class Node {
  private _flagsAndType = SnapshotNodeType.Unresolved;
  public children: Edge[] = null;
  public name: string = "(unknown)";
  public size: number = 0;

  public set type(type: SnapshotNodeType) {
    this._flagsAndType &= ~(NodeFlag.DataMask);
    this._flagsAndType |= type;
  }
  public get type(): SnapshotNodeType {
    return this._flagsAndType & NodeFlag.DataMask;
  }
  public setFlag(flag: NodeFlag): void {
    this._flagsAndType |= flag;
  }
  public unsetFlag(flag: NodeFlag): void {
    this._flagsAndType &= ~flag;
  }
  public hasFlag(flag: NodeFlag): boolean {
    return !!(this._flagsAndType & flag);
  }
  /**
   * Measures the number of properties on the node.
   * May require traversing hidden children.
   * This is the growth metric we use.
   */
  public numProperties(): number {
    let count = 0;
    if (this.children) {
      for (const child of this.children) {
        switch(child.snapshotType) {
          case SnapshotEdgeType.Internal:
            switch(child.indexOrName) {
              case "elements": {
                // Contains numerical properties, including those of
                // arrays and objects.
                const elements = child.to;
                // Only count if no children.
                if (!elements.children || elements.children.length === 0) {
                  count += Math.floor(elements.size / 8);
                }
                break;
              }
              case "table": {
                // Contains Map and Set object entries.
                const table = child.to;
                if (table.children) {
                  count += table.children.length;
                }
                break;
              }
              case "properties": {
                // Contains expando properties on DOM nodes,
                // properties storing numbers on objects,
                // etc.
                const props = child.to;
                if (props.children) {
                  count += props.children.length;
                }
                break;
              }
            }
            break;
          case SnapshotEdgeType.Hidden:
          case SnapshotEdgeType.Shortcut:
          case SnapshotEdgeType.Weak:
            break;
          default:
            count++;
            break;
        }
      }
    }
    return count;
  }
  public toString(): string {
    let rv: string[] = [];
    if (this.hasFlag(NodeFlag.VisitBit)) {
      rv.push("[V]");
    }
    if (this.hasFlag(NodeFlag.New)) {
      rv.push("New");
    }
    if (this.hasFlag(NodeFlag.Growing)) {
      rv.push("Growing");
    }
    if (this.children) {
      rv.push(`(${this.children.length})`);
    } else {
      rv.push(`(0)`);
    }
    return rv.join(" ");
  }
}

/**
 * Given a heap snapshot, builds a growth graph.
 */
export class GrowthGraphBuilder {
  private _lookupString: (id: number) => string;
  private _stringPool: Map<string, number>;
  private _currentNode: Node = null;
  private _nodeMap = new Map<number, Node>();
  private _globalRoot: Node = null;
  private _domRoot: Node = null;
  constructor(stringPool: Map<string, number>, lookupString: (id: number) => string) {
    this._lookupString = lookupString;
    this._stringPool = stringPool;
  }
  private _getOrMakeNode(id: number) {
    const node = this._nodeMap.get(id);
    if (!node) {
      const node = new Node();
      node.setFlag(NodeFlag.New);
      this._nodeMap.set(id, node);
      return node;
    }
    return node;
  }
  public get root(): Node {
    const root = new Node();
    root.name = "root";
    root.type = SnapshotNodeType.Synthetic;
    let edges: Edge[] = [
      new NamedEdge("window", this._globalRoot, SnapshotEdgeType.Hidden)
    ];
    edges = edges.concat(this._domRoot.children.map((c) => new NamedEdge("dom", c.to, SnapshotEdgeType.Hidden)));
    root.children = edges;
    if (root.children.length === 0 || this._globalRoot === null || this._domRoot === null) {
      throw new Error(`No GC roots found in snapshot?`);
    }
    return root;
  }
  public visitNode(type: SnapshotNodeType, name: number, id: number, selfSize: number, edgeCount: number): void {
    const nodeObject = this._getOrMakeNode(id);
    nodeObject.name = this._lookupString(name);
    if (nodeObject.name && (nodeObject.name.startsWith("Window "))) { // && nodeObject.type === SnapshotNodeType.Code) {
      // console.log(`${id} ${nodeObject.name}`);
      if (this._globalRoot) {
        throw new Error(`Multiple window nodes?!?`);
      }
      this._globalRoot = nodeObject;
    //  console.log(`Has ${edgeCount} children!!!`);
    }
    if (type === SnapshotNodeType.Synthetic && nodeObject.name === "(Document DOM trees)") {
      console.log("Found DOM root with " + edgeCount + " children.");
      if (edgeCount !== 1) {
        throw new Error(`Multiple DOMs: ${edgeCount}`);
      }
      this._domRoot = nodeObject;
    }
    nodeObject.type = type;
    nodeObject.size = selfSize;
    this._currentNode = nodeObject;
    if (edgeCount > 0) {
      this._currentNode.children = [];
    }
  }
  public visitEdge(type: SnapshotEdgeType, nameOrIndex: number, toNode: number): void {
    if (!this._currentNode) {
      throw new Error(`Invariant failure: Edge visited before node.`);
    }
    const edge = MakeEdge(type, nameOrIndex, this._getOrMakeNode(toNode), this._lookupString);
    if (edge) {
      this._currentNode.children.push(edge);
    }
  }
}

/**
 * BFS exploration of graph. Checks if nodes in the graph have grown.
 * @param prev Node from the previous snapshot at current heap path.
 * @param current Node from the current snapshot at current heap path.
 */
export function MergeGraphs(prevGraph: Node, currentGraph: Node): void {
  let frontier: Node[] = [];
  let queue: Node[] = [prevGraph, currentGraph];

  while (queue.length > 0) {
    const current = queue.pop();
    const prev = queue.pop();

    const visitBit = current.hasFlag(NodeFlag.VisitBit);
    if (!visitBit) {
      current.setFlag(NodeFlag.VisitBit);
      // `current` has an analogue in the previous snapshot, so it is no longer 'new'.
      current.unsetFlag(NodeFlag.New);

      //console.log(`${prev} -> ${current}`);

      // Nodes are either 'New', 'Growing', or 'Not Growing'.
      // Nodes begin as 'New', and transition to 'Growing' or 'Not Growing' after a snapshot.
      // So if a node is neither new nor consistently growing, we don't care about it.
      if ((prev.hasFlag(NodeFlag.New) || prev.hasFlag(NodeFlag.Growing)) && prev.numProperties() < current.numProperties()) {
      //current.children && ((prev.children === null && current.children.length > 0) || (prev.children && prev.children.length < current.children.length))) {
        current.setFlag(NodeFlag.Growing);
      }

      // Visit shared children. New children are ignored, and remain in the 'new' state.
      const prevEdges = new Map<string | number, Edge>();
      if (prev.children) {
        for (const edge of prev.children) {
          prevEdges.set(edge.indexOrName, edge);
        }
      }

      if (current.children) {
        for (const edge of current.children) {
          const prevEdge = prevEdges.get(edge.indexOrName);
          if (prevEdge && shouldTraverse(prevEdge)) {
            frontier.push(prevEdge.to, edge.to);
          }
        }
      }
    }

    if (queue.length === 0) {
      const temp = queue;
      queue = frontier;
      frontier = temp;
    }
  }
}

/**
 * Performs a BFS to find the shortest path to growing objects.
 * Returns a set of paths to each growing object.
 * @param root The root of the heap.
 */
export function FindGrowthPaths(root: Node): GrowthPath[][] {
  let visited = new Set<Edge>();
  let growingPaths = new Map<Node, GrowthPath[]>();
  let frontier: GrowthPath[] = root.children.map((e) => {
    visited.add(e);
    return new GrowthPath([e]);
  });
  let nextFrontier: GrowthPath[] = [];
  while (frontier.length > 0) {
    const path = frontier.shift();
    const node = path.end();
    if (node.hasFlag(NodeFlag.Growing)) {
      if (!growingPaths.has(node)) {
        growingPaths.set(node, []);
      }
      growingPaths.get(node).push(path);
    }
    // node.setFlag(NodeFlag.New);
    const children = node.children;
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) {
          if (shouldTraverse(child)) {
            visited.add(child);
            nextFrontier.push(path.addEdge(child));
          }
        }
      }
    }
    if (frontier.length === 0) {
      const temp = frontier;
      // Swap buffers; go one deeper.
      frontier = nextFrontier;
      nextFrontier = temp;
    }
  }

  // Convert from map into array of arrays.
  // We don't need to track the key anymore.
  const rv: GrowthPath[][] = [];
  growingPaths.forEach((paths) => rv.push(paths));
  return rv;
}

/**
 * A path from GC root to a growing heap object.
 */
export class GrowthPath {
  private _path: Edge[];

  constructor(path: Edge[]) {
    this._path = path;
  }

  public addEdge(e: Edge): GrowthPath {
    return new GrowthPath(this._path.concat(e));
  }

  public end(): Node {
    const len = this._path.length;
    if (len > 0) {
      return this._path[len - 1].to;
    }
    return null;
  }

  /**
   * Retrieves the path to the object in a serializeable format.
   */
  public toJSON(): SerializeableGCPath {
    let rv: SerializeableGCPath = {
      root: null,
      path: null
    };
    let path = this._path;
    const firstLink = path[0];
    if (firstLink.to.name.startsWith("Window ")) {
      rv.root = {
        type: RootType.GLOBAL
      };
    } else {
      // DOM object. Skip:
      // - DOM tree collection
      // - index
      rv.root = {
        type: RootType.DOM,
        elementType: path[1].to.name
      };
      path = path.slice(2);
    }

    rv.path = path.filter((l) => {
      if (l.type === EdgeType.CLOSURE) {
        return true;
      } else {
        return !isHidden(l.snapshotType);
      }
    });

    return rv;
  }
}