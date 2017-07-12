interface ListenerInfo {
  useCapture: boolean;
  listener: EventListenerOrEventListenerObject;
}

interface EventTarget {
  $$listeners?: {[type: string]: ListenerInfo[]};
}

/**
 * Agent injected into the webpage to surface browser-hidden leaks at the JS level.
 */
(function() {
  const addEventListener = EventTarget.prototype.addEventListener;
  const removeEventListener = EventTarget.prototype.removeEventListener;
  const r = /'/g;
  /**
   * Escapes single quotes in the given string.
   * @param s
   */
  function safeString(s: string): string {
    return s.replace(r, "\'");
  }

  function getOrSetObjectsForPath(get: boolean, p: SerializeableGCPath, proxies?: Map<any, any>): any[][] {
    let accessStr = "root";
    const root = p.root;
    let rootObjs: any[] = [];
    switch (root.type) {
      case RootType.DOM: {
        const elementType = root.elementType;
        if (elementType.startsWith("HTML") && elementType.endsWith("Element")) {
          const tag = elementType.slice(4, -7).toLowerCase();
          const elements = document.getElementsByTagName(tag);
          for (let i = 0; i < elements.length; i++) {
            rootObjs.push(elements[i]);
          }
        }
        break;
      }
      case RootType.GLOBAL:
        rootObjs.push(window);
        break;
    }
    const path = p.path;
    const lastEdge = path[path.length - 1];
    for (const l of path) {
      switch(l.type) {
        case EdgeType.CLOSURE:
          if (!get && l === lastEdge) {
            accessStr += `.__closureAssign__('${safeString(`${l.indexOrName}`)}', proxy)`;
          } else {
            accessStr += `.__closure__('${safeString(`${l.indexOrName}`)}')`;
          }
          break;
        case EdgeType.INDEX:
        case EdgeType.NAMED:
          accessStr += `['${safeString(`${l.indexOrName}`)}']`;
          if (!get && l === lastEdge) {
            accessStr += ` = proxy`;
          }
          break;
      }
    }
    if (get) {
      return rootObjs.map((root) => {
        "use strict";
        try {
          return [root, new Function("root", `return ${accessStr};`)(root)];
        } catch (e) {
          console.error(e);
          return null;
        }
      }).filter((o) => o !== null);
    } else {
      rootObjs.forEach((root, i) => {
        "use strict";
        if (proxies.has(root)) {
          try {
            new Function("root", "proxy", `${accessStr};`)(root, proxies.get(root));
          } catch (e) {
            console.error(e);
          }
        }
      });
      return null;
    }
  }

  function setObjectsForPath(p: SerializeableGCPath, proxies: Map<any, any>): void {
    getOrSetObjectsForPath(false, p, proxies);
  }

  function getObjectsForPath(p: SerializeableGCPath): any[][] {
    return getOrSetObjectsForPath(true, p);
  }

  EventTarget.prototype.addEventListener = function(this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, useCapture: boolean = false) {
    addEventListener.apply(this, arguments);
    if (!this.$$listeners) {
      this.$$listeners = {};
    }
    let listeners = this.$$listeners[type];
    if (!listeners) {
      listeners = this.$$listeners[type] = [];
    }
    for (const listenerInfo of listeners) {
      if (listenerInfo.listener === listener && listenerInfo.useCapture === useCapture) {
        return;
      }
    }
    listeners.push({
      listener: listener,
      useCapture: useCapture
    });
  };

  EventTarget.prototype.removeEventListener = function(this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, useCapture: boolean = false) {
    removeEventListener.apply(this, arguments);
    if (this.$$listeners) {
      const listeners = this.$$listeners[type];
      if (listeners) {
        for (let i = 0; i < listeners.length; i++) {
          const lInfo = listeners[i];
          if (lInfo.listener === listener && lInfo.useCapture === useCapture) {
            listeners.splice(i, 1);
            if (listeners.length === 0) {
              delete this.$$listeners[type];
            }
            return;
          }
        }
      }
    }
  };

  // Array of GC paths.
  // All should point to same object.
  //

  const stackTraces = new Map<SerializeableGCPath, Map<string | number | symbol, Set<string>>>();
  function addStack(map: Map<string | number | symbol, Set<string>>, property: string | number | symbol): void {
    try {
      throw new Error();
    } catch (e) {
      let set = map.get(property);
      if (!set) {
        set = new Set<string>();
        map.set(property, set);
      }
      set.add(e.stack);
    }
  }
  function removeStacks(map: Map<string | number | symbol, Set<string>>, property: string | number | symbol): void {
    if (map.has(property)) {
      map.delete(property);
    }
  }
  const secretStackMapProperty = "$$$stackmap$$$";
  const secretIsProxyProperty = "$$$isproxy$$$";
  // Disables proxy interception.
  let disableProxies = false;
  function instrumentPath(p: SerializeableGCPath[]): void {
    // Fetch the object.
    const objs = [].concat(...p.map((p) => getObjectsForPath(p)));
    // Check if first path is in map. If not, all paths should not be in map.
    let map = stackTraces.get(p[0]);
    if (!map) {
      map = new Map<string | number | symbol, Set<string>>();
      // Use shortest (0th) path as canonical path.
      stackTraces.set(p[0], map);
    }
    const proxies = new Map<any, any>();
    const proxiesByObject = new Map<any, any>();
    for (const objSet of objs) {
      // Ensure we use same proxy for same object.
      let finishedProxy = proxiesByObject.get(objSet[1]);
      if (!finishedProxy) {
        finishedProxy = new Proxy(objSet[1], {
          defineProperty: function(target, property, descriptor): boolean {
            if (!disableProxies) {
              // Capture a stack trace.
              addStack(map, property);
            }
            return Reflect.defineProperty(target, property, descriptor);
          },
          set: function(target, property, value, receiver): boolean {
            if (!disableProxies) {
              // Capture a stack trace.
              addStack(map, property);
            }
            return Reflect.set(target, property, value, receiver);
          },
          get: function(target, property, receiver): any {
            if (property === secretStackMapProperty) {
              return map;
            } else if (property === secretIsProxyProperty) {
              return true;
            } else {
              return Reflect.get(target, property, receiver);
            }
          },
          deleteProperty: function(target, property): boolean {
            if (!disableProxies) {
              // Remove stack traces that set this property.
              removeStacks(map, property);
            }
            return Reflect.deleteProperty(target, property);
          }
        });
        proxiesByObject.set(objSet[1], finishedProxy);
      }
      proxies.set(objSet[0], finishedProxy);
    }
    // Install proxies in the place of the roots.
    p.forEach((p) => setObjectsForPath(p, proxies));
  }

  function instrumentPaths(p: SerializeableGCPath[][]): void {
    for (const path of p) {
      instrumentPath(path);
    }
  }

  function getStackTraces(): string {
    const rv: {[p: string]: {[prop: string]: string[]}} = {};
    stackTraces.forEach((value, key) => {
      const map: {[prop: string]: string[]} = rv[JSON.stringify(key)] = {};
      value.forEach((stacks, prop) => {
        const stackArray = new Array<string>(stacks.size);
        let i = 0;
        stacks.forEach((v) => {
          stackArray[i] = v;
          i++;
        });
        map[prop] = stackArray;
      });
    });
    return JSON.stringify(rv);
  }

  window.$$instrumentPaths = instrumentPaths;
  window.$$getStackTraces = getStackTraces;

  // Array modeling
  Array.prototype.push = (function(push) {
    return function(this: Array<any>, ...items: any[]): number {
      try {
        disableProxies = true;
        if ((<any> this)[secretIsProxyProperty]) {
          const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
          for (let i = 0; i < items.length; i++) {
            addStack(map, `${this.length + i}`);
          }
        }
        return push.apply(this, items);
      } finally {
        disableProxies = false;
      }
    };
  })(Array.prototype.push);

  Array.prototype.unshift = (function(unshift) {
    return function(this: Array<any>, ...items: any[]): number {
      try {
        disableProxies = true;
        if ((<any> this)[secretIsProxyProperty]) {
          const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
          const newItemLen = items.length;
          for (let i = items.length - 1; i >= 0; i--) {
            map.set(`${i + newItemLen}`, map.get(`${i}`));
          }
          for (let i = 0; i < items.length; i++) {
            removeStacks(map, `${i}`);
            addStack(map, `${i}`);
          }
        }
        return unshift.apply(this, items);
      } finally {
        disableProxies = false;
      }
    };
  })(Array.prototype.unshift);

  Array.prototype.pop = (function(pop) {
    return function(this: Array<any>): any {
      try {
        disableProxies = true;
        if ((<any> this)[secretIsProxyProperty]) {
          const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
          removeStacks(map, `${this.length - 1}`);
        }
        return pop.apply(this);
      } finally {
        disableProxies = false;
      }
    };
  })(Array.prototype.pop);

  Array.prototype.shift = (function(shift) {
    return function(this: Array<any>): any {
      try {
        disableProxies = true;
        if ((<any> this)[secretIsProxyProperty]) {
          const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
          removeStacks(map, "0");
          for (let i = 1; i < this.length; i++) {
            map.set(`${i - 1}`, map.get(`${i}`));
          }
          removeStacks(map, `${this.length - 1}`);
        }
        return shift.apply(this);
      } finally {
        disableProxies = false;
      }
    };
  })(Array.prototype.shift);

  Array.prototype.splice = (function(splice) {
    return function(this: Array<any>, start: number, deleteCount: number, ...items: any[]): any {
      try {
        disableProxies = true;
        if ((<any> this)[secretIsProxyProperty]) {
          const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
          let actualStart = start | 0;
          if (actualStart === undefined) {
            return [];
          }
          // If greater than the length of the array, actual starting index will be set to the length of the array.
          if (actualStart > this.length) {
            actualStart = this.length;
          }
          // If negative, will begin that many elements from the end of the array (with origin 1)
          // and will be set to 0 if absolute value is greater than the length of the array.
          if (actualStart < 0) {
            actualStart = this.length + actualStart;
            if (actualStart < 0) {
              actualStart = 0;
            }
          }
          let actualDeleteCount = deleteCount | 0;
          // If deleteCount is omitted, or if its value is larger than array.length - start,
          //   then all of the elements beginning with start index on through the end of the array will be deleted.
          if (deleteCount === undefined || actualDeleteCount > this.length - actualStart) {
            actualDeleteCount = this.length - actualStart;
          }
          if (actualDeleteCount < 0) {
            actualDeleteCount = 0;
          }

          for (let i = 0; i < actualDeleteCount; i++) {
            const index = actualStart + i;
            removeStacks(map, `${index}`);
          }

          // Move existing traces into new locations.
          const newItemCount = items.length;
          if (newItemCount > actualDeleteCount) {
            // Shift *upward*
            const delta = newItemCount - actualDeleteCount;
            for (let i = this.length - 1; i >= actualStart + actualDeleteCount; i--) {
              map.set(`${i + delta}`, map.get(`${i}`));
            }
          } else if (newItemCount < actualDeleteCount) {
            // Shift *downward*
            const delta = newItemCount - actualDeleteCount;
            for (let i = actualStart + actualDeleteCount; i < this.length; i++) {
              map.set(`${i + delta}`, map.get(`${i}`));
            }
            // Delete extra traces for removed indexes.
            for (let i = this.length + delta; i < this.length; i++) {
              removeStacks(map, `${i}`);
            }
          }

          // Add new traces for new items.
          for (let i = 0; i < newItemCount; i++) {
            removeStacks(map, `${actualStart + i}`);
            addStack(map, `${actualStart + i}`);
          }
        }
        return splice.apply(this, arguments);
      } finally {
        disableProxies = false;
      }
    };
  })(Array.prototype.splice);

  // TODO: Sort, reverse, ...
})();