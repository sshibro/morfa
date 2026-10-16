//! A vector that keeps its first `N` elements inline (segment rings, point events and state
//! rings are almost always 1–4 long), so the common case allocates nothing.

#[derive(Clone)]
pub(super) struct SmallVec<T: Copy + Default, const N: usize> {
    len: u32,
    inline: [T; N],
    /// All the elements once there are more than `N`.
    heap: Vec<T>,
}

impl<T: Copy + Default, const N: usize> Default for SmallVec<T, N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Copy + Default, const N: usize> SmallVec<T, N> {
    pub(super) fn new() -> Self {
        SmallVec {
            len: 0,
            inline: [T::default(); N],
            heap: Vec::new(),
        }
    }

    pub(super) fn one(v: T) -> Self {
        let mut s = Self::new();
        s.push(v);
        s
    }

    #[inline]
    pub(super) fn len(&self) -> usize {
        self.len as usize
    }

    #[inline]
    pub(super) fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub(super) fn as_slice(&self) -> &[T] {
        let len = self.len as usize;
        if len <= N {
            &self.inline[..len]
        } else {
            &self.heap
        }
    }

    #[inline]
    pub(super) fn as_mut_slice(&mut self) -> &mut [T] {
        let len = self.len as usize;
        if len <= N {
            &mut self.inline[..len]
        } else {
            &mut self.heap
        }
    }

    #[inline]
    pub(super) fn push(&mut self, v: T) {
        let len = self.len as usize;
        if len < N {
            self.inline[len] = v;
        } else {
            if len == N {
                self.heap.clear();
                self.heap.extend_from_slice(&self.inline);
            }
            self.heap.push(v);
        }
        self.len += 1;
    }

    /// Keeps the elements for which `keep` holds, in order.
    pub(super) fn retain(&mut self, mut keep: impl FnMut(&T) -> bool) {
        let old = self.len as usize;
        let mut k = 0;
        for i in 0..old {
            let v = self.as_slice()[i];
            if keep(&v) {
                self.as_mut_slice()[k] = v;
                k += 1;
            }
        }
        if old > N && k <= N {
            let (inline, heap) = (&mut self.inline, &self.heap);
            inline[..k].copy_from_slice(&heap[..k]);
            self.heap.clear();
        } else if k > N {
            self.heap.truncate(k);
        }
        self.len = k as u32;
    }
}
