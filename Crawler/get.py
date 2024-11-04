import json
import requests
from bs4 import BeautifulSoup
import os
import re
import argparse
import concurrent.futures
import time
from typing import Optional
import requests.adapters
from requests.packages.urllib3.util.retry import Retry

def get_soup(url):
    try:
        response = requests.get(url)
        if response.status_code == 200:
            return BeautifulSoup(response.text, 'html.parser')
        else:
            print(f"获取页面失败: {url}, 状态码: {response.status_code}")
    except Exception as e:
        print(f"获取页面出错: {url}, 错误: {str(e)}")
    return None

def clean_filename(filename):
    # 移除不合法的文件名字符
    return re.sub(r'[\\/*?:"<>|]', '', filename)

def setup_requests_session() -> requests.Session:
    """创建一个带有重试机制的requests会话"""
    session = requests.Session()
    retry_strategy = Retry(
        total=3,  # 最大重试次数
        backoff_factor=0.5,  # 重试间隔时间
        status_forcelist=[500, 502, 503, 504]  # 需要重试的HTTP状态码
    )
    adapter = requests.adapters.HTTPAdapter(
        max_retries=retry_strategy,
        pool_connections=100,  # 连接池大小
        pool_maxsize=100
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

def download_single_image(args) -> Optional[bool]:
    """下载单个图片的函数"""
    url, filename, period_folder, session = args
    try:
        response = session.get(url, timeout=30)
        if response.status_code == 200:
            # 确保文件夹存在
            os.makedirs(period_folder, exist_ok=True)
            
            # 获取完整的文件路径
            filepath = os.path.join(period_folder, f"{filename}.jpg")
            
            # 写入文件
            with open(filepath, 'wb') as f:
                f.write(response.content)
            print(f"已下载: {filename}")
            return True
        else:
            print(f"下载失败 {filename}: HTTP状态码 {response.status_code}")
            return False
    except Exception as e:
        print(f"下载失败 {filename}: {str(e)}")
        return False

def download_images_parallel(images: list, period_folder: str, max_workers: int = 10) -> dict:
    """并行下载多个图片"""
    period_images = {}
    session = setup_requests_session()
    
    # 从 period_folder 中提取 period 名称
    period = os.path.basename(period_folder)
    
    # 准备下载参数
    download_args = [
        (img['url'], clean_filename(img['title']), 
         os.path.join('images', clean_filename(period), clean_filename(img.get('folder', ''))) if img.get('folder') else os.path.join('images', clean_filename(period)),
         session)
        for img in images
    ]
    
    # 使用线程池并行下载
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(download_single_image, args) for args in download_args]
        
        # 处理下载结果
        for img, future in zip(images, futures):
            try:
                if future.result():
                    # 记录相对路径
                    filename = clean_filename(img['title'])
                    relative_path = os.path.join('images',
                                               clean_filename(period),
                                               clean_filename(img.get('folder', '')) if img.get('folder') else '',
                                               f"{filename}.jpg")
                    if img['title'] not in period_images:
                        period_images[img['title']] = relative_path
            except Exception as e:
                print(f"处理下载结果时出错: {str(e)}")
    
    return period_images

def process_page(url):
    soup = get_soup(url)
    if not soup:
        return []
    
    current_folder = ""
    images = []
    seen_titles = {}  # 用于记录标题出现次数
    
    # 找到所有包含●的文本元素
    bullet_texts = soup.find_all(string=lambda text: text and '●' in text)
    
    for text_element in bullet_texts:
        # 确保●在文本开头
        title = text_element.strip()
        if not title.startswith('●'):
            continue
            
        # 如果是以"●20"开头，设置为当前文件夹
        if title.startswith('●20'):
            current_folder = title[1:]
            continue
            
        # 修改：查找距离最近的图片元素
        current = text_element
        closest_img = None
        min_distance = float('inf')
        
        # 向前查找所有图片元素
        all_previous = current.find_all_previous(['a', 'img'])
        for element in all_previous:
            # 如果是链接且包含图片
            if element.name == 'a' and element.find('img'):
                img = element.find('img')
                # 计算到标题的文本节点数量
                distance = len(list(filter(lambda x: isinstance(x, str) and x.strip(), 
                                        element.find_next_siblings(string=True))))
                if distance < min_distance:
                    min_distance = distance
                    closest_img = img
            # 如果直接是图片
            elif element.name == 'img':
                distance = len(list(filter(lambda x: isinstance(x, str) and x.strip(), 
                                        element.find_next_siblings(string=True))))
                if distance < min_distance:
                    min_distance = distance
                    closest_img = element
        
        if closest_img and closest_img.get('src'):
            # 处理重复标题
            if title in seen_titles:
                seen_titles[title] += 1
                title = f"{title}-{seen_titles[title]}"
            else:
                seen_titles[title] = 1
                
            images.append({
                'title': title[1:],  # 去掉●符号
                'url': re.sub(r'/s\d+/', '/s0/', closest_img['src']),
                'folder': current_folder
            })
        else:
            print(f"警告: 未找到标题 '{title}' 对应的图片")
    
    return images

def main():
    # 添加命令行参数
    parser = argparse.ArgumentParser(description='下载博客图片')
    parser.add_argument('--test', type=int, choices=[1, 2], help='试运行模式：1=每个页面只下载5张图片，2=只处理追加分页面且每页限制5张图片')
    parser.add_argument('--threads', type=int, default=10, help='下载线程数（默认10）')
    args = parser.parse_args()
    
    # 创建主图片文件夹
    base_folder = 'images'
    os.makedirs(base_folder, exist_ok=True)
    
    # 读取URL配置
    with open('get_urls.json', 'r', encoding='utf-8') as f:
        urls = json.load(f)
    
    # 用于存储图片路径的字典
    article_data = {}
    
    # 遍历每个页面
    for period, url in urls.items():
        # 在测试模式2下，跳过非blog-post页面
        if args.test == 2 and 'blog-post_' not in url:
            continue
            
        print(f"\n处理页面: {period}")
        
        # 创建页面文件夹
        period_folder = os.path.join(base_folder, clean_filename(period))
        os.makedirs(period_folder, exist_ok=True)
        
        # 获取该页面的所有图片
        images = process_page(url)
        
        # 在测试模式下限制图片数量
        if args.test and len(images) > 5:
            print(f"试运行模式{args.test}：限制下载前5张图片（共找到 {len(images)} 张）")
            images = images[:5]
        
        # 并行下载图片并获取结果
        period_images = download_images_parallel(images, period_folder, args.threads)
        
        # 将该时期的图片信息添加到总数据中
        if period_images:  # 只有当有图片时才添加
            article_data[period] = period_images
    
    # 将图片路径信息写入JSON文件
    with open('article.json', 'w', encoding='utf-8') as f:
        json.dump(article_data, f, ensure_ascii=False, indent=2)
    print("\n图片路径信息已保存到 article.json")

if __name__ == "__main__":
    main()
