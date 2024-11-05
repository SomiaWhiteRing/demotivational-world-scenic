let articles = null;
let descriptions = null;
let favorites = JSON.parse(localStorage.getItem('favorites') || '[]');

// 在文件开头添加标记初次加载的变量
let isFirstLoad = !localStorage.getItem('hasLoaded');

// 在文件开头添加以下代码
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  // 本地环境下注销所有 ServiceWorker
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      registrations.forEach(registration => {
        registration.unregister();
        console.log('ServiceWorker 已在本地环境下禁用');
      });
    });
  }
} else {
  // 生产环境下正常注册 ServiceWorker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(registration => {
        console.log('ServiceWorker 注册成功:', registration.scope);
      }).catch(error => {
        console.log('ServiceWorker 注册失败:', error);
      });
    });
  }
}

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
  } else if (period === 'favorite') {
    // 处理收藏列表
    Object.keys(articles).forEach(key => {
      Object.entries(articles[key]).forEach(([title, path]) => {
        if (favorites.includes(path)) {
          images.push({ title, path, period: key });
        }
      });
    });

    if (images.length === 0) {
      // 收藏为空时直接显示提示文本，不渲染画廊
      description.textContent = i18n[currentLang].noFavorite;
      description.classList.add('visible');
      gallery.innerHTML = ''; // 清空画廊
      gallery.style.height = '0'; // 收起画廊区域
      return; // 直接返回，不继续执行渲染逻辑
    } else {
      description.textContent = `${images.length} ${i18n[currentLang].nav.favorite}`;
      description.classList.add('visible');
    }
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
    initPromise: null, // 添加初始化Promise缓存

    async init() {
      if (this.initPromise) return this.initPromise;
      if (this.db) return Promise.resolve();

      this.initPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('ImageCache', 1);

        request.onerror = (event) => {
          console.error('IndexedDB 打开失败:', event.target.error);
          this.initPromise = null;
          reject(event.target.error);
        };

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

      return this.initPromise;
    },

    async getImage(path) {
      try {
        if (!this.db) await this.init();

        return new Promise((resolve) => {
          const transaction = this.db.transaction(['images'], 'readonly');
          const store = transaction.objectStore('images');
          const request = store.get(path);

          request.onsuccess = () => resolve(request.result);
          request.onerror = (event) => {
            console.error('从缓存获取图片失败:', path, event.target.error);
            resolve(null);
          };
        });
      } catch (error) {
        console.error('访问缓存失败:', error);
        return null;
      }
    },

    async saveImage(path, blob) {
      if (!this.db) await this.init();

      return new Promise((resolve, reject) => {
        try {
          const transaction = this.db.transaction(['images'], 'readwrite');
          const store = transaction.objectStore('images');
          const item = { path, blob, timestamp: Date.now() };
          const request = store.put(item);

          request.onsuccess = () => resolve();
          request.onerror = (event) => {
            console.error('缓存图片失败:', path, event.target.error);
            reject(event.target.error);
          };
        } catch (error) {
          console.error('保存到缓存失败:', error);
          reject(error);
        }
      });
    }
  };

  // 修改 loadImages 函数
  async function loadImages() {
    let loadedCount = 0;
    const imagePromises = images.map(async (image, index) => {
      try {
        // 首先尝试从 IndexedDB 获取缓存的图片
        const cachedImage = await imageDB.getImage(image.path);

        if (cachedImage && cachedImage.blob) {
          loadedCount++;
          if (isFirstLoad) {
            updateLoadingProgress(loadedCount, images.length, true);
          }

          const img = new Image();
          const objectUrl = URL.createObjectURL(cachedImage.blob);

          return new Promise((resolve) => {
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              resolve({
                ...image,
                width: img.width,
                height: img.height,
                blob: cachedImage.blob  // 保存 blob 数据以供后续使用
              });
            };
            img.src = objectUrl;
          });
        }

        // 如果没有缓存，从网络加载
        const response = await fetch(image.path);
        const blob = await response.blob();

        // 保存到 IndexedDB
        try {
          await imageDB.saveImage(image.path, blob);
        } catch (cacheError) {
          console.warn('缓存图片失败:', cacheError);
        }

        loadedCount++;
        if (isFirstLoad) {
          updateLoadingProgress(loadedCount, images.length, false);
        }

        const img = new Image();
        return new Promise((resolve) => {
          img.onload = () => {
            resolve({
              ...image,
              width: img.width,
              height: img.height,
              blob: blob  // 保存 blob 数据以供后续使用
            });
          };
          img.src = URL.createObjectURL(blob);
        });

      } catch (error) {
        console.warn('从网络加载图片失败，尝试使用缓存:', error);

        // 网络请求失败时，再次尝试从 IndexedDB 读取
        try {
          const cachedImage = await imageDB.getImage(image.path);
          if (cachedImage && cachedImage.blob) {
            loadedCount++;
            if (isFirstLoad) {
              updateLoadingProgress(loadedCount, images.length, true);
            }

            const img = new Image();
            const objectUrl = URL.createObjectURL(cachedImage.blob);

            return new Promise((resolve) => {
              img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve({
                  ...image,
                  width: img.width,
                  height: img.height,
                  blob: cachedImage.blob  // 保存 blob 数据以供后续使用
                });
              };
              img.src = objectUrl;
            });
          }
        } catch (cacheError) {
          console.warn('从缓存加载图片也失败:', cacheError);
        }

        // 如果所有尝试都失败，返回错误状态
        loadedCount++;
        if (isFirstLoad) {
          updateLoadingProgress(loadedCount, images.length, false);
        }

        return {
          ...image,
          width: 300,
          height: 300,
          error: true
        };
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

  // 修改 calculateLayout 函数中的关相代码
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

    // 尝试 localStorage 获取缓存
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
      console.warn('缓存失败:', error);
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

  // 渲染片
  async function renderGallery() {
    try {
      loadingMask.classList.add('visible');
      const loadedImages = await loadImages();
      const containerWidth = gallery.clientWidth - (parseFloat(getComputedStyle(document.documentElement).fontSize) * 2) -
        (deviceUtils.isMobile() ? 0 : deviceUtils.getScrollBarWidth());

      const positions = calculateLayout(loadedImages, containerWidth);

      gallery.innerHTML = '';
      gallery.appendChild(loadingMask);

      const BATCH_SIZE = 20;
      for (let i = 0; i < loadedImages.length; i += BATCH_SIZE) {
        const batch = loadedImages.slice(i, i + BATCH_SIZE);

        batch.forEach((image, batchIndex) => {
          const index = i + batchIndex;
          const item = document.createElement('div');
          item.className = 'gallery-item placeholder';
          item.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px)`;
          item.style.width = `${positions[index].width}px`;
          item.style.height = `${positions[index].height}px`;

          const isFavorite = favorites.includes(image.path);

          const createImageElement = async () => {
            if (image.error) {
              return {
                html: `
                  <div class="error-placeholder">
                    <span>${i18n[currentLang].loadError || '图片加载失败'}</span>
                  </div>
                `,
                blob: null
              };
            }

            try {
              let imageBlob;

              if (image.blob) {
                imageBlob = image.blob;
              } else {
                const cachedImage = await imageDB.getImage(image.path);
                if (cachedImage && cachedImage.blob) {
                  imageBlob = cachedImage.blob;
                }
              }

              // 创建一个空的img标签，稍后设置src
              return {
                html: `<img alt="${image.title}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover;">`,
                blob: imageBlob
              };
            } catch (error) {
              console.error('创建图片元素失败:', error);
              return {
                html: `
                  <div class="error-placeholder">
                    <span>${i18n[currentLang].loadError || '图片加载失败'}</span>
                  </div>
                `,
                blob: null
              };
            }
          };

          // 异步设置图片内容
          createImageElement().then(({ html, blob }) => {
            // 先设置基本的HTML结构
            item.innerHTML = `
              <div class="image-container" style="width: 100%; height: 100%;">
                ${html}
              </div>
              <div class="title-container">
                <div class="title">${image.title}</div>
                <button class="favorite-btn ${isFavorite ? 'active' : ''}" data-path="${image.path}">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  </svg>
                </button>
              </div>
            `;

            const img = item.querySelector('img');
            if (img && blob) {
              const objectUrl = URL.createObjectURL(blob);

              img.onload = () => {
                item.classList.remove('placeholder');
              };

              img.onerror = (e) => {
                console.error('图片加载失败:', image.title, e);
                URL.revokeObjectURL(objectUrl);
                item.innerHTML = `
                  <div class="error-placeholder">
                    <span>${i18n[currentLang].loadError || '图片加载失败'}</span>
                  </div>
                `;
              };

              img.dataset.objectUrl = objectUrl;
              img.src = objectUrl;
            } else if (!blob) {
              img.src = image.path;
            }

            // 添加收藏按钮点击事件
            const favoriteBtn = item.querySelector('.favorite-btn');
            if (favoriteBtn) {
              favoriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(favoriteBtn, favoriteBtn.dataset.path);
              });
            }
          });


          // 为每个图片项添加点击事件
          item.addEventListener('click', (e) => {
            e.preventDefault();

            // 准备 PhotoSwipe 的图片数组
            const items = loadedImages.map(img => {
              // 如果有 blob 数据，使用 blob URL
              if (img.blob) {
                const blobUrl = URL.createObjectURL(img.blob);
                return {
                  src: blobUrl,
                  w: img.width,
                  h: img.height,
                  title: img.title
                };
              }
              // 否则使用原始路径
              return {
                src: img.path,
                w: img.width,
                h: img.height,
                title: img.title
              };
            });

            // 配置 PhotoSwipe 选项
            const options = {
              dataSource: items,
              index: index,
              closeOnVerticalDrag: true,
              padding: { top: 20, bottom: 20, left: 20, right: 20 },
              bgOpacity: 0.9,
              showHideOpacity: true,
              errorMsg: i18n[currentLang].loadError || '图片加载失败'
            };

            // 创建并初始化 PhotoSwipe
            const lightbox = new PhotoSwipeLightbox({
              ...options,
              pswpModule: PhotoSwipe
            });

            // 添加关闭时的清理
            lightbox.on('destroy', () => {
              // 清理所有为 PhotoSwipe 创建的 blob URLs
              items.forEach(item => {
                if (item.src.startsWith('blob:')) {
                  URL.revokeObjectURL(item.src);
                }
              });
            });

            lightbox.init();
            lightbox.loadAndOpen(index);
          });

          gallery.appendChild(item);
        });

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
  // 先加载数据
  loadData().then(() => {
    // 获取URL参数中的period
    const urlParams = new URLSearchParams(window.location.search);
    const periodFromUrl = urlParams.get('period') || 'all';

    const buttons = document.querySelectorAll('.period-btn');
    buttons.forEach(button => {
      // 移除可能存在的旧事件监听器
      button.replaceWith(button.cloneNode(true));
    });

    // 重新获取按钮并添加事件监听
    document.querySelectorAll('.period-btn').forEach(button => {
      button.addEventListener('click', () => {
        const period = button.dataset.period;

        // 更新URL参数
        const newUrl = new URL(window.location);
        newUrl.searchParams.set('period', period);
        window.history.pushState({}, '', newUrl);

        // 更新按钮状态和显示
        document.querySelectorAll('.period-btn').forEach(btn => {
          btn.classList.remove('active');
        });
        button.classList.add('active');
        displayImages(period);
      });

      // 根据URL参数设置初始active状态
      if (button.dataset.period === periodFromUrl) {
        button.classList.add('active');
        displayImages(periodFromUrl);
      }
    });

    // 处理浏览器前进后退
    window.addEventListener('popstate', () => {
      const params = new URLSearchParams(window.location.search);
      const period = params.get('period') || 'all';

      document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
      });
      displayImages(period);
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

      // 保存言择
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

// 添加收藏变化时重新渲染的功能
function handleFavoriteChange() {
  const activeButton = document.querySelector('.period-btn.active');
  if (activeButton && activeButton.dataset.period === 'favorite') {
    displayImages('favorite');
  }
}

// 修改收藏按钮点击事件处理
function toggleFavorite(btn, path) {
  const index = favorites.indexOf(path);

  if (index === -1) {
    favorites.push(path);
    btn.classList.add('active');
  } else {
    favorites.splice(index, 1);
    btn.classList.remove('active');
  }

  localStorage.setItem('favorites', JSON.stringify(favorites));
  handleFavoriteChange(); // 如果在收藏页面,则重新渲染
}

// 修改进度更新函数
function updateLoadingProgress(current, total, fromCache) {
  const loadingMask = document.querySelector('.loading-mask');
  if (!loadingMask) return;

  // 确保进度条容器存在
  let progressContainer = loadingMask.querySelector('.progress-container');
  if (!progressContainer) {
    loadingMask.innerHTML += `
      <div class="progress-container">
        <div class="progress-text">${i18n[currentLang].loading.initializing}</div>
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
        <div class="progress-detail">
          <span class="progress-numbers">0/${total}</span>
          <span class="cache-status"></span>
        </div>
        <div class="progress-tip">${i18n[currentLang].loading.tip}</div>
      </div>
    `;
    progressContainer = loadingMask.querySelector('.progress-container');
  }

  // 更新进度
  const percentage = (current / total) * 100;
  const progressFill = progressContainer.querySelector('.progress-fill');
  const progressNumbers = progressContainer.querySelector('.progress-numbers');
  const cacheStatus = progressContainer.querySelector('.cache-status');
  const progressText = progressContainer.querySelector('.progress-text');

  progressFill.style.width = `${percentage}%`;
  progressNumbers.textContent = `${current}/${total}`;
  cacheStatus.textContent = fromCache ?
    i18n[currentLang].loading.fromCache :
    i18n[currentLang].loading.caching;

  // 当加载完成时
  if (current === total) {
    localStorage.setItem('hasLoaded', 'true');
    isFirstLoad = false;

    // 更新加载文本
    progressText.textContent = i18n[currentLang].loading.building;

    // 先等待加载圈自然消失
    const spinner = loadingMask.querySelector('.loading-spinner');
    if (spinner) {
      spinner.addEventListener('transitionend', () => {
        // 加载圈消失后，再移除整个加载遮罩
        setTimeout(() => {
          loadingMask.classList.remove('visible');
          setTimeout(() => loadingMask.remove(), 300);
        }, 200);
      }, { once: true });
    }
  }
}

// 在组件卸载或页面切换时清理所有objectUrl
function cleanupObjectUrls() {
  const images = document.querySelectorAll('img[data-object-url]');
  images.forEach(img => {
    if (img.dataset.objectUrl) {
      URL.revokeObjectURL(img.dataset.objectUrl);
    }
  });
}

// 在相关的清理函数中调用（比如切换页面时）
window.addEventListener('beforeunload', cleanupObjectUrls);