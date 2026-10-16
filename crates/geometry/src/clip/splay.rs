//! A literal port of the `splaytree` 3.2.3 package (the parts polygon-clipping uses).
//!
//! polygon-clipping's comparators are not pure (`SweepEvent.compare` links coincident points
//! and can consume segments) and are not always a consistent order, so the exact sequence of
//! comparator calls matters. This tree reproduces the package's top-down splay, `insert`,
//! `add`, `remove`, `pop`, `find`, `prev` and `next` call for call. Nodes live in an arena;
//! index 0 is the splay's temporary header node.

/// "No node" (JS `null`).
pub(super) const NONE: u32 = u32::MAX;
/// The header node used by `splay` (JS `new Node(null, null)`).
const HEAD: u32 = 0;

#[derive(Clone, Copy)]
struct Node<K> {
    key: K,
    left: u32,
    right: u32,
}

pub(super) struct SplayTree<K> {
    nodes: Vec<Node<K>>,
    free: Vec<u32>,
    root: u32,
    size: usize,
}

impl<K: Copy + Default> SplayTree<K> {
    pub(super) fn new() -> Self {
        let nodes = vec![Node {
            key: K::default(),
            left: NONE,
            right: NONE,
        }];
        SplayTree {
            nodes,
            free: Vec::new(),
            root: NONE,
            size: 0,
        }
    }

    /// Removes every node, keeping the arena's memory.
    pub(super) fn clear(&mut self) {
        self.nodes.truncate(1);
        self.free.clear();
        self.root = NONE;
        self.size = 0;
    }

    pub(super) fn size(&self) -> usize {
        self.size
    }

    pub(super) fn key(&self, node: u32) -> K {
        self.nodes[node as usize].key
    }

    fn alloc(&mut self, key: K) -> u32 {
        let node = Node {
            key,
            left: NONE,
            right: NONE,
        };
        if let Some(i) = self.free.pop() {
            self.nodes[i as usize] = node;
            i
        } else {
            self.nodes.push(node);
            (self.nodes.len() - 1) as u32
        }
    }

    #[inline]
    fn l(&self, n: u32) -> u32 {
        self.nodes[n as usize].left
    }
    #[inline]
    fn r(&self, n: u32) -> u32 {
        self.nodes[n as usize].right
    }
    #[inline]
    fn set_l(&mut self, n: u32, v: u32) {
        self.nodes[n as usize].left = v;
    }
    #[inline]
    fn set_r(&mut self, n: u32, v: u32) {
        self.nodes[n as usize].right = v;
    }

    /// `splay(i, t, comparator)` (function `u` in the minified dist).
    fn splay<F: FnMut(K, K) -> i32>(&mut self, i: K, mut t: u32, cmp: &mut F) -> u32 {
        self.set_l(HEAD, NONE);
        self.set_r(HEAD, NONE);
        let mut l = HEAD;
        let mut r = HEAD;
        loop {
            let o = cmp(i, self.key(t));
            if o < 0 {
                if self.l(t) == NONE {
                    break;
                }
                if cmp(i, self.key(self.l(t))) < 0 {
                    let s = self.l(t);
                    self.set_l(t, self.r(s));
                    self.set_r(s, t);
                    t = s;
                    if self.l(t) == NONE {
                        break;
                    }
                }
                self.set_l(r, t);
                r = t;
                t = self.l(t);
            } else if o > 0 {
                if self.r(t) == NONE {
                    break;
                }
                if cmp(i, self.key(self.r(t))) > 0 {
                    let s = self.r(t);
                    self.set_r(t, self.l(s));
                    self.set_l(s, t);
                    t = s;
                    if self.r(t) == NONE {
                        break;
                    }
                }
                self.set_r(l, t);
                l = t;
                t = self.r(t);
            } else {
                break;
            }
        }
        self.set_r(l, self.l(t));
        self.set_l(r, self.r(t));
        self.set_l(t, self.r(HEAD));
        self.set_r(t, self.l(HEAD));
        t
    }

    /// `insert(key)`: inserts, allowing duplicates. Returns the new root (the new node).
    pub(super) fn insert<F: FnMut(K, K) -> i32>(&mut self, key: K, cmp: &mut F) -> u32 {
        self.size += 1;
        let n = self.alloc(key);
        if self.root == NONE {
            self.root = n;
            return n;
        }
        let e = self.splay(key, self.root, cmp);
        let i = cmp(key, self.key(e));
        if i < 0 {
            self.set_l(n, self.l(e));
            self.set_r(n, e);
            self.set_l(e, NONE);
        } else {
            self.set_r(n, self.r(e));
            self.set_l(n, e);
            self.set_r(e, NONE);
        }
        self.root = n;
        n
    }

    /// `add(key)`: inserts only if no equal key is present. Returns the root node, which holds
    /// the key (or the equal key already present).
    pub(super) fn add<F: FnMut(K, K) -> i32>(&mut self, key: K, cmp: &mut F) -> u32 {
        let n = self.alloc(key);
        let was_empty = self.root == NONE;
        if was_empty {
            self.size += 1;
            self.root = n;
        }
        let i = self.splay(key, self.root, cmp);
        let o = cmp(key, self.key(i));
        if o == 0 {
            self.root = i;
            if i != n {
                self.free.push(n);
            }
        } else {
            if o < 0 {
                self.set_l(n, self.l(i));
                self.set_r(n, i);
                self.set_l(i, NONE);
            } else {
                self.set_r(n, self.r(i));
                self.set_l(n, i);
                self.set_r(i, NONE);
            }
            self.size += 1;
            self.root = n;
        }
        self.root
    }

    /// `remove(key)`.
    pub(super) fn remove<F: FnMut(K, K) -> i32>(&mut self, key: K, cmp: &mut F) {
        self.root = self.remove_from(key, self.root, cmp);
    }

    /// `_remove(key, root)`.
    fn remove_from<F: FnMut(K, K) -> i32>(&mut self, t: K, e: u32, cmp: &mut F) -> u32 {
        if e == NONE {
            return NONE;
        }
        let e = self.splay(t, e, cmp);
        if cmp(t, self.key(e)) == 0 {
            let l = if self.l(e) == NONE {
                self.r(e)
            } else {
                let l = self.splay(t, self.l(e), cmp);
                self.set_r(l, self.r(e));
                l
            };
            self.size -= 1;
            self.free.push(e);
            l
        } else {
            e
        }
    }

    /// `pop()`: removes and returns the smallest key (as the comparator sees it).
    pub(super) fn pop<F: FnMut(K, K) -> i32>(&mut self, cmp: &mut F) -> Option<K> {
        let mut t = self.root;
        if t == NONE {
            return None;
        }
        while self.l(t) != NONE {
            t = self.l(t);
        }
        let k = self.key(t);
        self.root = self.splay(k, self.root, cmp);
        self.root = self.remove_from(k, self.root, cmp);
        Some(k)
    }

    /// `find(key)` (splaying).
    pub(super) fn find<F: FnMut(K, K) -> i32>(&mut self, key: K, cmp: &mut F) -> Option<u32> {
        if self.root == NONE {
            return None;
        }
        self.root = self.splay(key, self.root, cmp);
        if cmp(key, self.key(self.root)) != 0 {
            None
        } else {
            Some(self.root)
        }
    }

    /// `next(node)`.
    pub(super) fn next<F: FnMut(K, K) -> i32>(&self, node: u32, cmp: &mut F) -> Option<u32> {
        let mut e = self.root;
        let mut r = NONE;
        if self.r(node) != NONE {
            r = self.r(node);
            while self.l(r) != NONE {
                r = self.l(r);
            }
            return Some(r);
        }
        let k = self.key(node);
        while e != NONE {
            let i = cmp(k, self.key(e));
            if i == 0 {
                break;
            }
            if i < 0 {
                r = e;
                e = self.l(e);
            } else {
                e = self.r(e);
            }
        }
        if r == NONE { None } else { Some(r) }
    }

    /// `prev(node)`.
    pub(super) fn prev<F: FnMut(K, K) -> i32>(&self, node: u32, cmp: &mut F) -> Option<u32> {
        let mut e = self.root;
        let mut r = NONE;
        if self.l(node) != NONE {
            r = self.l(node);
            while self.r(r) != NONE {
                r = self.r(r);
            }
            return Some(r);
        }
        let k = self.key(node);
        while e != NONE {
            let i = cmp(k, self.key(e));
            if i == 0 {
                break;
            }
            if i < 0 {
                e = self.l(e);
            } else {
                r = e;
                e = self.r(e);
            }
        }
        if r == NONE { None } else { Some(r) }
    }
}
