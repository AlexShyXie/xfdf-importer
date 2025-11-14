import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, FileSystemAdapter } from 'obsidian';
import { DOMParser } from 'xmldom';

interface XFDFImporterSettings {
    xfdfFolder: string;
    targetFile: string;
    headerLevel: number; // 新增：自动插入的标题层级
}

const DEFAULT_SETTINGS: XFDFImporterSettings = {
    xfdfFolder: '16_PDFxchangeAnnot',
    targetFile: '11_影像学习/书籍pdfAnnotation.md',
    headerLevel: 2 // 默认2级标题
}

export default class XFDFImporterPlugin extends Plugin {
	settings: XFDFImporterSettings;
	// 在 XFDFImporterPlugin 类中添加这个递归搜索函数
	private async findXfdfFiles(folder: TFolder): Promise<TFile[]> {
		let xfdfFiles: TFile[] = [];
		
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'xfdf') {
				xfdfFiles.push(child);
			} else if (child instanceof TFolder) {
				// 递归搜索子文件夹
				xfdfFiles = xfdfFiles.concat(await this.findXfdfFiles(child));
			}
		}
		
		return xfdfFiles;
	}
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'import-xfdf-annotations',
			name: 'Import XFDF Annotations',
			callback: () => {
				this.importAnnotations();
			}
		});

		this.addSettingTab(new XFDFImporterSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- 核心逻辑：从你的 JS 文件完整移植而来 ---

	// 1. HTML实体解码函数
	decodeHtmlEntities(str: string) {
		if (!str) return str;
		return str.replace(/&amp;/g, '&')
				 .replace(/&lt;/g, '<')
				 .replace(/&gt;/g, '>')
				 .replace(/&quot;/g, '"')
				 .replace(/&#39;/g, "'")
				 .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d))
				 .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
	}

	// 2. 【核心移植】路径转换函数
	convertToFullyEncodedUnixPathXFDF(windowsPath: string) {
		let unixPath = windowsPath.replace(/^([A-Z]):\\/, '$1:/');
		unixPath = unixPath.replace(/\\/g, '/');
		return encodeURIComponent(unixPath);
	}

	// 修改 generatePxceLink 函数，接收 TFile 对象而不是文件名
	generatePxceLink(xfdfFile: TFile, pageNum: number, commentId: string): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("Error: Cannot generate link, vault is not a local file system.");
			return "";
		}
		
		// 直接从 xfdfFile 对象获取库内路径
		const xfdfVaultPath = xfdfFile.path;
		const vaultPath = adapter.getBasePath();
		const xfdfAbsolutePath = `${vaultPath}\\${xfdfVaultPath.replace(/\//g, '\\')}`;
		const encodedXfdfPath = this.convertToFullyEncodedUnixPathXFDF(xfdfAbsolutePath);

		// 使用 comment ID 直接定位
		const pxceLink = `pxce:file:///${encodedXfdfPath}#page=${pageNum};view=FitH;comment=${commentId}`;
		
		return pxceLink;
	}


	// 4. 【核心移植】轻量级 XFDF 解析器 (使用 DOMParser 版本)
	XFDFParser = {
		getTextContent: (annotNode: Element) => {
			// 【新增】首先检查 flags 属性，如果包含 "hidden"，则直接忽略
			const flags = annotNode.getAttribute('flags');
			if (flags && flags.includes('hidden')) {
				return null;
			}

			// 【关键修改】统一逻辑：只要没有 <contents-richtext> 就返回 null
			const richTextNode = annotNode.getElementsByTagName('contents-richtext')[0];
			if (!richTextNode) {
				// 无论什么类型，只要没有 contents-richtext 就返回 null
				return null;
			}

			// 如果有 <contents-richtext>，就尝试解析内容
			const bodyNode = richTextNode.getElementsByTagName('body')[0];
			if (bodyNode) {
				const spanNodes = bodyNode.getElementsByTagName('span');
				const textParts: string[] = [];
				for (let i = 0; i < spanNodes.length; i++) {
					const spanNode = spanNodes[i];
					const textContent = spanNode.textContent;
					if (textContent) {
						textParts.push(this.decodeHtmlEntities(textContent.trim()));
					}
				}
				// 【关键】即使内容为空，也返回空字符串 ""，而不是 null
				return textParts.filter(Boolean).join(' ');
			}

			// 如果有 contents-richtext 但没有 body，也返回空字符串
			return "";
		},

		getAttribute: (annotNode: Element, attrName: string) => {
			return annotNode.getAttribute(attrName);
		}
	}


	private async generatePdfInternalLink(xfdfFile: TFile, pageNum: number, rect?: string, color?: string): Promise<string> {
		try {
			// 读取XFDF文件内容
			// 读取XFDF文件内容
			const content = await this.app.vault.read(xfdfFile);
			const parser = new DOMParser();
			const xmlDoc = parser.parseFromString(content, "text/xml");

			// 【修复】使用 getElementsByTagName 替代 querySelector
			const fElements = xmlDoc.getElementsByTagName("f");
			let pdfFileElement: Element | null = null;
			
			// 查找带有 href 属性的 f 元素
			for (let i = 0; i < fElements.length; i++) {
				const element = fElements[i];
				if (element.getAttribute("href")) {
					pdfFileElement = element;
					break;
				}
			}
			
			if (!pdfFileElement) {
				console.warn("No PDF path found in XFDF file:", xfdfFile.path);
				return "";
			}
			let finalPdfPath: string;
			let pdfPath = pdfFileElement.getAttribute("href") || "";
			if (!pdfPath) {
				console.warn("Empty PDF path in XFDF file:", xfdfFile.path);
				return "";
			}
			
			else if (/^[A-Za-z]:/.test(pdfPath)) {
				// 处理 G:/... 格式
				finalPdfPath = pdfPath.replace(/\//g, '\\');
			}
			else if (pdfPath.startsWith('./') || pdfPath.startsWith('../') || !pdfPath.includes(':')) {
				// 处理相对路径格式
				const { join } = require('path');
				
				const adapter = this.app.vault.adapter;
				if (adapter instanceof FileSystemAdapter) {
					const vaultBasePath = adapter.getBasePath();
					const xfdfDirPath = xfdfFile.path.substring(0, xfdfFile.path.lastIndexOf('/'));
					let absolutePath = join(vaultBasePath, xfdfDirPath, pdfPath);
					finalPdfPath = absolutePath.replace(/\//g, '\\');
				} else {
					new Notice("Cannot resolve relative path: vault is not using file system adapter");
					return "";
				}
			}
			else {
				new Notice(`Unsupported PDF path format:"${pdfPath}"`);
				
				return "";
			}

			// 【改进】更智能的路径匹配策略
			const adapter = this.app.vault.adapter;
			if (adapter instanceof FileSystemAdapter) {
				const vaultBasePath = adapter.getBasePath().replace(/\\/g, '/');
				const normalizedPdfPath = finalPdfPath.replace(/\\/g, '/');
				
				// 策略1：检查PDF路径是否以vault基础路径开头
				if (normalizedPdfPath.startsWith(vaultBasePath + '/') || normalizedPdfPath === vaultBasePath) {
					// PDF在库内，使用相对路径
					const relativePath = normalizedPdfPath.substring(vaultBasePath.length + 1);
					finalPdfPath = relativePath;
				} else {
					// 策略2：PDF不在库内，但文件夹/文件名结构在库内存在
					//let thispath = normalizedPdfPath.replace(/ /g, "%20");
					const pdfPathParts = normalizedPdfPath.split('/');
					
					// 从最深层级开始，逐步向上查找匹配的 库内文件夹/文件名
					// 【简化】直接取最后两层：文件夹/文件名
					if (pdfPathParts.length >= 2) {
						const lastFolder = pdfPathParts[pdfPathParts.length - 2]; // 倒数第二层：文件夹名
						const fileName = pdfPathParts[pdfPathParts.length - 1]; // 最后一层：文件名
						const candidatePath = `${lastFolder}/${fileName}`; // 如：02%20系统解剖学/第11章%20%20心血管系统.pdf
						
						// 遍历库内所有PDF文件，查找路径结尾匹配的文件
						const allPdfFiles = this.app.vault.getFiles().filter(file => file.extension === 'pdf');
						
						for (const pdfFile of allPdfFiles) {
							//new Notice(`${pdfFile.path}`);
							// 检查库内文件的路径是否以 candidatePath 结尾
							if (pdfFile.path.endsWith(candidatePath)) {
								// 找到匹配的库内PDF文件，使用完整的库内路径
								finalPdfPath = pdfFile.path;
								console.log(`Found matching PDF in vault: ${pdfFile.path}`);
								break;
							}
						}
					}
				}
			}


			// 提取文件名用于显示
			//const pdfFileName = finalPdfPath.split('\\').pop() || finalPdfPath.split('/').pop() || "PDF";
			finalPdfPath = finalPdfPath.replace(/ /g, "%20")
			// 构建PDF内部链接
			let pdfLink = `${finalPdfPath}#page=${pageNum}`;
			
			// 如果有坐标信息，添加到链接中
			if (rect) {
				pdfLink += `&rect=${rect}`;
			}
			if (color && color !== 'undefined') {
				pdfLink += `&color=${color}`;
			}
			
			return pdfLink;
			
		} catch (error) {
			new Notice("Failed to generate PDF internal link:", error);
			return "";
		}
	}


	// 5. 【核心移植】解析 XFDF 字符串为快照行 (使用 DOMParser 版本)
	parseXFDFToSnapshot(xfdfString: string): string[] {
		const snapshotLines: string[] = [];
		
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(xfdfString, 'text/xml');
			
			const annotsNode = doc.getElementsByTagName('annots')[0];
			if (!annotsNode) {
				return snapshotLines; // 如果没有 <annots> 节点，直接返回空数组
			}

			const annotationNodes = annotsNode.childNodes;
			for (let i = 0; i < annotationNodes.length; i++) {
				const node = annotationNodes[i];
				// 确保是元素节点并且是我们关心的类型
				if (node.nodeType === 1 && (node as Element).tagName) {
					const annotNode = node as Element;
					const tag = annotNode.tagName.toLowerCase();
					
					// 你原来的 tagNames 列表
					const tagNames = ["highlight", "squiggly", "underline", "strikeout", "text", "freetext", "square", "circle", "line", "polygon", "polyline", "ink"];
					if (tagNames.includes(tag)) {
						const annotType = tag.charAt(0).toUpperCase() + tag.slice(1);
						const contents = this.XFDFParser.getTextContent(annotNode);
						// 【新增优化】如果内容为 null (包括被 hidden 的)，直接跳过此注释
						if (contents === null) {
							continue;
						}
						const rect = this.XFDFParser.getAttribute(annotNode, 'rect');
						const subject = this.XFDFParser.getAttribute(annotNode, 'subject');
						const name = this.XFDFParser.getAttribute(annotNode, 'name');
						// 修改为：
						const page = this.XFDFParser.getAttribute(annotNode, 'page');
						const pageNum = (page ? parseInt(page, 10) : 0) + 1;

						// 新的快照格式：Type|Contents|Rect|Color|Subject|Name|Page
						let snapshotLine = `${annotType}|${contents}|${rect || ""}|undefined|${subject || ""}|${name || ""}|${pageNum || ""}`;
						snapshotLines.push(snapshotLine);
					}
				}
			}
		} catch (error) {
			console.error("XFDF parsing failed:", error);
			new Notice("XFDF 解析失败，请检查文件格式。");
		}

		return snapshotLines;
	}

	async importAnnotations() {
		const { xfdfFolder, targetFile } = this.settings;

		// 1. 读取现有文件内容
		let target = this.app.vault.getAbstractFileByPath(targetFile);
		if (!target) {
			await this.app.vault.create(targetFile, '');
			target = this.app.vault.getAbstractFileByPath(targetFile);
		}
		const targetFileObj = target as TFile;
		const originalLines = (await this.app.vault.read(targetFileObj)).split('\n');

		// 2. 解析所有XFDF，获取所有注释数据，并按文档名分组
		const allNewAnnotations: { [docTitle: string]: any[] } = {};
		const xfdfFolderAbstractFile = this.app.vault.getAbstractFileByPath(xfdfFolder);
		if (!xfdfFolderAbstractFile || !(xfdfFolderAbstractFile instanceof TFolder)) {
			new Notice(`Error: XFDF folder "${xfdfFolder}" not found.`);
			return;
		}
		// 使用新的递归搜索方法
		const xfdfFiles = await this.findXfdfFiles(xfdfFolderAbstractFile);

		for (const file of xfdfFiles) {
			// file 现在是 TFile 对象，不需要再次获取
			if (!file) continue;
			const xfdfString = await this.app.vault.read(file);
			
			// 使用 file.path 获取完整路径，然后提取文件名
			const fileName = file.name;
			const docTitle = fileName.replace(/\.xfdf$/, '');

			const snapshotLines = this.parseXFDFToSnapshot(xfdfString);
			if (snapshotLines.length === 0) {
				continue;
			}

			// 先收集所有需要处理的注释
			const annotationPromises = snapshotLines.map(async (line) => {
				const [type, contents, rect, color, subject, name, page] = line.split('|');
				const uniqueId = name || `${docTitle}-${Date.now()}`;
				const pageNum = (page ? parseInt(page, 10) : 1);

				// 生成 pxce 链接
				const pxceLink = this.generatePxceLink(file, pageNum, uniqueId);

				// 异步生成PDF内部链接
				const pdfInternalLink = await this.generatePdfInternalLink(file, pageNum, rect, color);

				// 生成 Obsidian 链接，包含两个链接
				const obsidianLink = `${contents || '查看注释'} [${docTitle}：第${pageNum}页](${pdfInternalLink}) [pxceLink](${pxceLink})`;

				return {
					uniqueId,
					obsidianLink,
					type,
					contents,
					rect,
					color,
					subject,
					name,
					page: pageNum
				};
			});

			// 等待所有异步操作完成
			const annotations = await Promise.all(annotationPromises);

			// 存储到 allNewAnnotations
			if (!allNewAnnotations[docTitle]) {
				allNewAnnotations[docTitle] = [];
			}
			allNewAnnotations[docTitle].push(...annotations);
		}

		// 【新增】统计变量
		let totalNewAnnotations = 0;
		let totalUpdatedAnnotations = 0;
		let totalSkippedAnnotations = 0;

		// 3. 【核心新逻辑】重建文件内容，智能保留用户修改
		const finalContentLines: string[] = [];
		let currentLineIndex = 0;
		const processedTitles = new Set<string>();

		// 辅助函数：从注释行中提取 uniqueId
		const getIdFromLine = (line: string) => {
			const match = line.match(/<!--\s*(.+?)\s*-->/);
			return match ? match[1] : null;
		};

		// 新增：专门检测2级标题的函数
		const isH2Title = (line: string): string | null => {
			const trimmedLine = line.trim();
			const h2Match = trimmedLine.match(/^##\s+(.*)/);
			return h2Match ? h2Match[1] : null;
		};

		while (currentLineIndex < originalLines.length) {
			const line = originalLines[currentLineIndex];
			const trimmedLine = line.trim();

			// 检查是否是2级标题（这是我们关心的）
			const h2Title = isH2Title(line);
			if (h2Title) {
				const titleText = h2Title;
				processedTitles.add(titleText);

				// 将标题行加入最终内容
				finalContentLines.push(line);
				currentLineIndex++;

				// 获取这个标题对应的新注释
				const newAnnotationsForTitle = allNewAnnotations[titleText] || [];
				const newIds = new Set(newAnnotationsForTitle.map(a => a.uniqueId));

				// 收集这个2级标题下的所有内容，直到遇到下一个同级或更高级标题
				while (currentLineIndex < originalLines.length) {
					const peekLine = originalLines[currentLineIndex];
					const peekTrimmed = peekLine.trim();
					
					// 检查是否遇到标题（任何层级）
					const nextTitleMatch = peekTrimmed.match(/^(#+)\s+(.*)/);
					if (nextTitleMatch) {
						// 如果是同级（2级）或更高级（1级）标题，停止
						if (nextTitleMatch[1].length <= 2) {
							break;
						}
						// 如果是更低级（3级及以上）标题，继续处理
					}

					const oldId = getIdFromLine(peekLine);

					// 在处理现有注释时使用更精确的比较
					// 在处理现有注释的部分，使用简单的字符串比较
					if (oldId && newIds.has(oldId)) {
						const newAnnotation = newAnnotationsForTitle.find(a => a.uniqueId === oldId);
						if (newAnnotation) {
							// 简单比较：检查旧行是否包含新链接的关键信息
							const hasPdfLinkChanged = !peekLine.includes(newAnnotation.page.toString()) || 
													!peekLine.includes(newAnnotation.uniqueId);
							
							if (hasPdfLinkChanged) {
								// 链接有变化，更新
								finalContentLines.push(`- ${newAnnotation.obsidianLink} <!--${newAnnotation.uniqueId} -->[tag:: ]`);
								totalUpdatedAnnotations++;
							} else {
								// 链接没变化，保留原行
								finalContentLines.push(peekLine);
								totalSkippedAnnotations++;
							}
						}
						currentLineIndex++;
					} else {
						finalContentLines.push(peekLine);
						currentLineIndex++;
					}
				}

				// 最后，添加所有在XFDF中存在、但在旧文件中没有的全新注释
				const processedIds = new Set<string>();
				// 先扫描一遍，看看哪些ID已经被处理过了
				for (const line of finalContentLines) {
					const id = getIdFromLine(line);
					if (id) processedIds.add(id);
				}

				for (const newAnnot of newAnnotationsForTitle) {
					if (!processedIds.has(newAnnot.uniqueId)) {
						finalContentLines.push(`- ${newAnnot.obsidianLink} <!--${newAnnot.uniqueId} -->[tag:: ]`);
						totalNewAnnotations++; // 【新增】统计新增的注释
					}
				}

			} else {
				// 如果不是2级标题，直接将该行加入最终内容
				finalContentLines.push(line);
				currentLineIndex++;
			}
		}

		// 4. 处理所有没有找到对应标题的"孤儿"注释，并为它们创建新标题
		const orphanTitles = Object.keys(allNewAnnotations).filter(title => !processedTitles.has(title));

		if (orphanTitles.length > 0) {
			finalContentLines.push('\n\n---\n');
			for (const docTitle of orphanTitles) {
				const headerPrefix = '#'.repeat(this.settings.headerLevel);
				finalContentLines.push(`\n${headerPrefix} ${docTitle}\n`);
				const newAnnotationLines = allNewAnnotations[docTitle].map(annot => {
					totalNewAnnotations++; // 【新增】统计新增的注释
					return `- ${annot.obsidianLink} <!-- ${annot.uniqueId} -->[tag:: ]`;
				});
				finalContentLines.push(...newAnnotationLines);
			}
		}

		// 5. 【新增】生成统计信息并显示相应提示
		const totalChanges = totalNewAnnotations + totalUpdatedAnnotations;
		
		if (totalChanges === 0) {
			new Notice('XFDF annotations: No changes detected');
		} else {
			let message = `XFDF annotations imported successfully! `;
			const changes = [];
			
			if (totalNewAnnotations > 0) {
				changes.push(`+${totalNewAnnotations} new`);
			}
			if (totalUpdatedAnnotations > 0) {
				changes.push(`↑${totalUpdatedAnnotations} updated`);
			}
			if (totalSkippedAnnotations > 0) {
				changes.push(`○${totalSkippedAnnotations} unchanged`);
			}
			
			message += changes.join(', ');
			new Notice(message);
		}

		// 6. 写入文件（仅在有变化时）
		if (totalChanges > 0) {
			await this.app.vault.modify(targetFileObj, finalContentLines.join('\n').trim());
		}
	}


}
// --- 设置页面的代码 ---
class XFDFImporterSettingTab extends PluginSettingTab {
	plugin: XFDFImporterPlugin;

	constructor(app: App, plugin: XFDFImporterPlugin) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Settings for XFDF Importer'});

		new Setting(containerEl)
			.setName('XFDF Folder Path')
			.setDesc('The folder (relative to vault root) where your .xfdf files are stored.')
			.addText(text => text
				.setPlaceholder('e.g., PDFxchangeAnnot')
				.setValue(this.plugin.settings.xfdfFolder)
				.onChange(async (value) => {
					this.plugin.settings.xfdfFolder = value;
					await this.plugin.saveSettings();
				}));

		// 重新添加这个设置
		new Setting(containerEl)
			.setName('Target Markdown File')
			.setDesc('The markdown file to import annotations into.')
			.addText(text => text
				.setPlaceholder('e.g., Folder/Note.md')
				.setValue(this.plugin.settings.targetFile)
				.onChange(async (value) => {
					this.plugin.settings.targetFile = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Annotation Header Level')
			.setDesc('The header level for automatically generated annotation titles.')
			.addDropdown(dropdown => {
				dropdown
					.addOption('1', 'Level 1 (#)')
					.addOption('2', 'Level 2 (##)')
					.addOption('3', 'Level 3 (###)')
					.setValue(this.plugin.settings.headerLevel.toString())
					.onChange(async (value) => {
						this.plugin.settings.headerLevel = parseInt(value);
						await this.plugin.saveSettings();
					});
			});
	}
}


