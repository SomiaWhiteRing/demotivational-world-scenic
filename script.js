let articles = null;
let descriptions = null;

// 将所有语言相关的代码整合在一起
const currentLang = (() => {
  // 获取用户语言
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  } else if (lang.startsWith('en')) {
    return 'en';
  }
  return 'ja'; // 默认日语
})();

async function loadData() {
  const [articlesResponse, descriptionsResponse] = await Promise.all([
    fetch('article.json'),
    fetch('desc.json')
  ]);

  articles = await articlesResponse.json();
  descriptions = await descriptionsResponse.json();

  displayImages('all');
}

function displayImages(period) {
  const gallery = document.querySelector('.gallery');
  const description = document.querySelector('.description');
  const aboutContainer = document.querySelector('.about-container');

  // 处理关于页面的显示
  if (period === 'about') {
    gallery.style.display = 'none';
    description.style.display = 'none';
    aboutContainer.classList.add('visible');
    return;
  }

  // 其他页面显示时隐藏关于页面
  gallery.style.display = 'block';
  description.style.display = 'block';
  aboutContainer.classList.remove('visible');

  // 首先清空gallery、重设高度并添加加载遮罩
  gallery.style.height = '300px';
  gallery.innerHTML = `
    <div class="loading-mask visible">
      <div class="loading-spinner"></div>
    </div>
  `;

  const loadingMask = gallery.querySelector('.loading-mask');

  let images = [];

  if (period === 'all') {
    Object.keys(articles).forEach(key => {
      Object.entries(articles[key]).forEach(([title, path]) => {
        images.push({ title, path, period: key });
      });
    });
    description.textContent = '';
    description.classList.remove('visible');
  } else if (period === 'random') {
    // 获取所有图片
    const allImages = [];
    Object.keys(articles).forEach(key => {
      Object.entries(articles[key]).forEach(([title, path]) => {
        allImages.push({ title, path, period: key });
      });
    });

    // 随机抽取40张图片
    const selectedImages = new Set();
    while (selectedImages.size < Math.min(40, allImages.length)) {
      const randomIndex = Math.floor(Math.random() * allImages.length);
      selectedImages.add(randomIndex);
    }

    images = Array.from(selectedImages).map(index => allImages[index]);
    description.textContent = i18n[currentLang].random;
    description.classList.add('visible');
  } else {
    Object.entries(articles[period]).forEach(([title, path]) => {
      images.push({ title, path, period });
    });
    description.textContent = descriptions[period];
    description.classList.add('visible');
  }

  // 添加 IndexedDB 相关函数
  const imageDB = {
    db: null,

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('ImageCache', 1);

        request.onerror = () => reject(request.error);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains('images')) {
            db.createObjectStore('images', { keyPath: 'path' });
          }
        };

        request.onsuccess = (event) => {
          this.db = event.target.result;
          resolve();
        };
      });
    },

    async getImage(path) {
      if (!this.db) await this.init();

      return new Promise((resolve) => {
        const transaction = this.db.transaction(['images'], 'readonly');
        const store = transaction.objectStore('images');
        const request = store.get(path);

        request.onsuccess = () => resolve(request.result);
      });
    },

    async saveImage(path, blob) {
      if (!this.db) await this.init();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['images'], 'readwrite');
        const store = transaction.objectStore('images');
        const item = { path, blob, timestamp: Date.now() };
        const request = store.put(item);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  };

  // 修改 loadImages 函数
  async function loadImages() {
    const imagePromises = images.map(async (image) => {
      try {
        // 首先尝试从 IndexedDB 获取缓存的图片
        const cachedImage = await imageDB.getImage(image.path);

        if (cachedImage) {
          // 如果有缓存，使用缓存的图片
          const img = new Image();
          const objectUrl = URL.createObjectURL(cachedImage.blob);

          return new Promise((resolve) => {
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              resolve({
                ...image,
                width: img.width,
                height: img.height
              });
            };
            img.src = objectUrl;
          });
        } else {
          // 如果没有缓存，从网络加载并缓存
          const response = await fetch(image.path);
          const blob = await response.blob();
          await imageDB.saveImage(image.path, blob);

          const img = new Image();
          return new Promise((resolve) => {
            img.onload = () => {
              resolve({
                ...image,
                width: img.width,
                height: img.height
              });
            };
            img.src = URL.createObjectURL(blob);
          });
        }
      } catch (error) {
        console.warn('加载图片失:', error);
        // 如果缓存失败，直接加载图片
        const img = new Image();
        return new Promise((resolve) => {
          img.onload = () => {
            resolve({
              ...image,
              width: img.width,
              height: img.height
            });
          };
          img.src = image.path;
        });
      }
    });

    return Promise.all(imagePromises);
  }

  // 添加缓存对象
  const layoutCache = {};

  // 判断设备类型和获取滚动条宽度的工具函数
  const deviceUtils = {
    _isMobile: null,
    _scrollBarWidth: null,

    getScrollBarWidth() {
      if (this._scrollBarWidth !== null) {
        return this._scrollBarWidth;
      }

      const outer = document.createElement('div');
      outer.style.cssText = `
        visibility: hidden;
        overflow: scroll;
        position: absolute;
        top: -9999px;
        width: 100px;
        height: 100px;
      `;

      const inner = document.createElement('div');
      inner.style.width = '100%';
      outer.appendChild(inner);

      document.body.appendChild(outer);
      const scrollBarWidth = outer.offsetWidth - inner.offsetWidth;
      outer.remove();

      this._scrollBarWidth = scrollBarWidth;
      return scrollBarWidth;
    },

    isMobile() {
      if (this._isMobile !== null) {
        return this._isMobile;
      }
      this._isMobile = this.getScrollBarWidth() === 0;
      return this._isMobile;
    }
  };

  // 修改 calculateLayout 函数中的相关代码
  function calculateLayout(items, containerWidth) {
    const remSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const paddingWidth = remSize * 2;

    // 根据设备类型决定是否减去滚动条宽度
    const scrollbarWidth = deviceUtils.isMobile() ? 0 : deviceUtils.getScrollBarWidth();
    const availableWidth = containerWidth - paddingWidth - scrollbarWidth;

    // 根据容器宽度确定列数
    let columns;
    if (availableWidth <= 800) {
      columns = 2;
    } else if (availableWidth <= 1200) {
      columns = 3;
    } else if (availableWidth <= 1400) {
      columns = 4;
    } else if (availableWidth <= 2000) {
      columns = 5;
    } else {
      columns = 6;
    }

    // 生成基于列数的缓存键
    const cacheKey = `layout_${columns}_${items.length}_${JSON.stringify(items.map(item => ({
      width: item.width,
      height: item.height
    })))}`;

    // 尝试从 localStorage 获取缓存
    try {
      const cachedLayout = localStorage.getItem(cacheKey);
      if (cachedLayout) {
        const { positions, containerHeight } = JSON.parse(cachedLayout);

        // 根据当前容器宽度调整缓存的位置
        const scale = containerWidth / positions.referenceWidth;
        const scaledPositions = positions.items.map(pos => ({
          x: pos.x * scale,
          y: pos.y * scale,
          width: pos.width * scale,
          height: pos.height * scale
        }));

        gallery.style.height = `${containerHeight * scale}px`;
        return scaledPositions;
      }
    } catch (error) {
      console.warn('读取布局缓存失败:', error);
    }

    const gap = 16;
    // 计算基准宽度（用于存储缓存）
    const referenceWidth = columns * 400; // 假设每列基准宽度为400px
    const columnWidth = (referenceWidth - (gap * (columns - 1))) / columns;

    const columnHeights = new Array(columns).fill(0);
    const positions = [];

    items.forEach((item) => {
      // 计算实际显示尺寸，保持宽高比
      let displayHeight = (item.height / item.width) * columnWidth;
      const displayWidth = columnWidth;  // 保持列宽一致

      // 添加最小高度限制：列数 * 50
      const minHeight = columns * 50;
      displayHeight = Math.max(displayHeight, minHeight);

      let shortestColumn = 0;
      let shortestHeight = columnHeights[0];
      for (let i = 1; i < columns; i++) {
        if (columnHeights[i] < shortestHeight) {
          shortestColumn = i;
          shortestHeight = columnHeights[i];
        }
      }

      const x = shortestColumn * (columnWidth + gap);
      const y = columnHeights[shortestColumn];

      positions.push({
        x,
        y,
        width: displayWidth,
        height: displayHeight  // 使用添加了最小高度限制的显示高度
      });

      columnHeights[shortestColumn] += displayHeight + gap;
    });

    const maxHeight = Math.max(...columnHeights);

    // 存储到 localStorage
    try {
      const layoutData = {
        positions: {
          referenceWidth,
          items: positions
        },
        containerHeight: maxHeight
      };
      localStorage.setItem(cacheKey, JSON.stringify(layoutData));
    } catch (error) {
      console.warn('存储布局缓存失败:', error);
    }

    // 缩放到实际尺寸
    const scale = containerWidth / referenceWidth;
    const scaledPositions = positions.map(pos => ({
      x: pos.x * scale,
      y: pos.y * scale,
      width: pos.width * scale,
      height: pos.height * scale
    }));

    gallery.style.height = `${maxHeight * scale}px`;
    return scaledPositions;
  }

  // 添加缓存清理函数
  function clearLayoutCache() {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('layout_')) {
        localStorage.removeItem(key);
      }
    });
  }

  // 渲染图片
  async function renderGallery() {
    try {
      loadingMask.classList.add('visible');

      // 先获取图片尺寸信息
      const loadedImages = await loadImages();
      const containerWidth = gallery.clientWidth - (parseFloat(getComputedStyle(document.documentElement).fontSize) * 2) -
        (deviceUtils.isMobile() ? 0 : deviceUtils.getScrollBarWidth());

      // 计算布局
      const positions = calculateLayout(loadedImages, containerWidth);

      // 清空现有内容
      gallery.innerHTML = '';
      // 重新添加加载遮罩
      gallery.appendChild(loadingMask);

      // 分批加载图片
      const BATCH_SIZE = 20;
      for (let i = 0; i < loadedImages.length; i += BATCH_SIZE) {
        const batch = loadedImages.slice(i, i + BATCH_SIZE);

        // 为这一批创建所有占位元素
        batch.forEach((image, batchIndex) => {
          const index = i + batchIndex;
          const item = document.createElement('div');
          item.className = 'gallery-item placeholder';
          item.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px)`;
          item.style.width = `${positions[index].width}px`;
          item.style.height = `${positions[index].height}px`;
          gallery.appendChild(item);
        });

        // 加载这一批的图片
        await Promise.all(batch.map((image, batchIndex) => {
          const index = i + batchIndex;
          const item = gallery.children[index + 1]; // +1 是因为第一个子元素是 loadingMask

          return new Promise(resolve => {
            item.innerHTML = `
              <img src="${image.path}" alt="${image.title}" loading="lazy">
              <div class="title">${image.title}</div>
            `;
            item.classList.remove('placeholder');
            item.classList.add('visible');
            resolve();
          });
        }));

        // 加载完第一批后移除遮罩
        if (i === 0) {
          loadingMask.classList.remove('visible');
          setTimeout(() => loadingMask.remove(), 300);
        }
      }
    } catch (error) {
      console.error('渲染图库失败:', error);
      loadingMask.classList.remove('visible');
    }
  }

  renderGallery();
}

document.addEventListener('DOMContentLoaded', () => {
  loadData();

  const buttons = document.querySelectorAll('.period-btn');
  buttons.forEach(button => {
    button.addEventListener('click', () => {
      buttons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      displayImages(button.dataset.period);
    });
  });

  // 添加防抖函
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // 添加窗口调整大小的处理函数
  const handleResize = debounce(() => {
    const activeButton = document.querySelector('.period-btn.active');
    if (activeButton) {
      displayImages(activeButton.dataset.period);
    } else {
      displayImages('all');
    }
  }, 200); // 200ms 的防抖延迟

  window.addEventListener('resize', handleResize);

  initLanguageSwitch();
});

// 添加导航栏滚动阴影效果
window.addEventListener('scroll', () => {
  const header = document.querySelector('header');
  if (window.scrollY > 0) {
    header.style.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.3)';
  } else {
    header.style.boxShadow = 'none';
  }
});

// 语言切换功能
function initLanguageSwitch() {
  const langBtns = document.querySelectorAll('.lang-btn');

  langBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentLang = btn.dataset.lang;

      // 更新按钮状态
      langBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 更新界面文本
      updateUIText();

      // 保存语言选择
      localStorage.setItem('preferredLanguage', currentLang);
    });
  });

  // 加载保存的语言选择
  const savedLang = localStorage.getItem('preferredLanguage');
  if (savedLang) {
    const langBtn = document.querySelector(`[data-lang="${savedLang}"]`);
    if (langBtn) langBtn.click();
  }
}

// 更新界面文本
function updateUIText() {
  // 更新导航按钮文本
  const allBtn = document.querySelector('[data-period="all"]');
  const randomBtn = document.querySelector('[data-period="random"]');
  const aboutBtn = document.querySelector('[data-period="about"]');

  if (allBtn) allBtn.textContent = i18n[currentLang].nav.all;
  if (randomBtn) randomBtn.textContent = i18n[currentLang].nav.random;
  if (aboutBtn) aboutBtn.textContent = i18n[currentLang].nav.about;

  // 更新关于页面内容
  const aboutTitle = document.querySelector('.about-title');
  const aboutContent = document.querySelector('.about-content');

  if (aboutTitle) aboutTitle.textContent = i18n[currentLang].about.title;
  if (aboutContent) {
    const descriptionContainer = aboutContent.querySelector('div') || aboutContent;
    descriptionContainer.innerHTML += i18n[currentLang].about.description;
  }
}

// 在页面加载时初始化
document.addEventListener('DOMContentLoaded', updateUIText);

// 注册 Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('ServiceWorker 注册成功:', registration.scope);
      })
      .catch(error => {
        console.log('ServiceWorker 注册失败:', error);
      });
  });
} 