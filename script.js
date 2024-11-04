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
  gallery.innerHTML = '';

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

  // 计算瀑布流布局
  function calculateLayout(items, containerWidth) {
    const gap = 16; // 1rem的间距
    let columns = 6; // 默认最大6列

    // 根据容器宽度确定列数
    if (containerWidth <= 800) columns = 2;
    else if (containerWidth <= 1200) columns = 3;
    else if (containerWidth <= 1600) columns = 4;
    else if (containerWidth <= 2000) columns = 5;

    const columnWidth = (containerWidth - (gap * (columns - 1))) / columns;
    const columnHeights = new Array(columns).fill(0);
    const positions = [];

    items.forEach((item, index) => {
      // 计算图片显示高度
      const displayHeight = (item.height / item.width) * columnWidth;

      // 找出最短的列
      let shortestColumn = 0;
      let shortestHeight = columnHeights[0];

      for (let i = 1; i < columns; i++) {
        if (columnHeights[i] < shortestHeight) {
          shortestColumn = i;
          shortestHeight = columnHeights[i];
        }
      }

      // 计算位置
      const x = shortestColumn * (columnWidth + gap);
      const y = columnHeights[shortestColumn];

      positions.push({
        x,
        y,
        width: columnWidth,
        height: displayHeight
      });

      // 更新列高度
      columnHeights[shortestColumn] += displayHeight + gap;
    });

    // 设置容器高度
    const maxHeight = Math.max(...columnHeights);
    gallery.style.height = `${maxHeight}px`;

    return positions;
  }

  // 渲染图片
  async function renderGallery() {
    const loadedImages = await loadImages();
    const containerWidth = gallery.clientWidth;
    const positions = calculateLayout(loadedImages, containerWidth);

    loadedImages.forEach((image, index) => {
      const div = document.createElement('div');
      div.className = 'gallery-item';
      div.innerHTML = `
        <img src="${image.path}" alt="${image.title}" loading="lazy">
        <div class="title">${image.title}</div>
      `;

      // 设置位置
      div.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px)`;
      div.style.width = `${positions[index].width}px`;

      gallery.appendChild(div);

      setTimeout(() => {
        div.classList.add('visible');
      }, index * 50);
    });
  }

  renderGallery();

  // 添加窗口调整大小时重新布局的功能
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      renderGallery();
    }, 100);
  });
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