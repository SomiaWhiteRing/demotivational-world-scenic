let articles = null;
let descriptions = null;

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
  } else {
    Object.entries(articles[period]).forEach(([title, path]) => {
      images.push({ title, path, period });
    });
    description.textContent = descriptions[period];
    description.classList.add('visible');
  }

  // 创建并等待所有图片加载完成
  async function loadImages() {
    const imagePromises = images.map(image => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          resolve({
            ...image,
            width: img.width,
            height: img.height
          });
        };
        img.src = image.path;
      });
    });

    return Promise.all(imagePromises);
  }

  // 添加缓存对象
  const layoutCache = {};

  // 修改 calculateLayout 函数
  function calculateLayout(items, containerWidth) {
    // 根据容器宽度确定列数
    let columns;
    if (containerWidth <= 800) {
      columns = 2;
    } else if (containerWidth <= 1200) {
      columns = 3;
    } else if (containerWidth <= 1600) {
      columns = 4;
    } else if (containerWidth <= 2000) {
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
      // 确保加载遮罩可见
      loadingMask.classList.add('visible');

      const loadedImages = await loadImages();
      const remSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // 如果当前是pc端，还要减去滚动条宽度
      const getScrollBarWidth = () => {
        // 创建外层容器
        const outer = document.createElement('div');
        outer.style.cssText = `
          visibility: hidden;
          overflow: scroll;
          position: absolute;
          top: -9999px;
          width: 100px;
          height: 100px;
        `;

        // 创建内层容器
        const inner = document.createElement('div');
        inner.style.width = '100%';
        outer.appendChild(inner);

        // 添加到 DOM 并计算
        document.body.appendChild(outer);
        const scrollBarWidth = outer.offsetWidth - inner.offsetWidth;

        // 清理 DOM
        outer.remove();

        return scrollBarWidth;
      };

      const scrollbarWidth = getScrollBarWidth();
      const containerWidth = gallery.clientWidth - remSize * 2 - scrollbarWidth;

      // 添加图片容器，但保持遮罩层和高度
      gallery.style.height = '300px';
      gallery.innerHTML = `
        <div class="loading-mask visible">
          <div class="loading-spinner"></div>
        </div>
      `;

      const positions = calculateLayout(loadedImages, containerWidth);

      loadedImages.forEach((image, index) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.innerHTML = `
          <img src="${image.path}" alt="${image.title}" loading="lazy">
          <div class="title">${image.title}</div>
        `;

        // 设置位置和尺寸
        item.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px)`;
        item.style.width = `${positions[index].width}px`;
        item.style.height = `${positions[index].height}px`;

        gallery.appendChild(item);

        setTimeout(() => {
          item.classList.add('visible');
        }, index * 50);
      });
    } finally {
      // 找到新创建的遮罩层并隐藏它
      const mask = gallery.querySelector('.loading-mask');
      if (mask) {
        mask.classList.remove('visible');
        // 短暂延迟后移除遮罩层
        setTimeout(() => {
          mask.remove();
        }, 300); // 与CSS过渡时间匹配
      }
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

  // 添加防抖函数
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