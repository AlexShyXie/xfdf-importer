import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, FileSystemAdapter } from 'obsidian';
import { DOMParser } from 'xmldom';

interface XFDFImporterSettings {
	xfdfFolder: string;
	targetFile: string;
}

const DEFAULT_SETTINGS: XFDFImporterSettings = {
	xfdfFolder: 'PDFxchangeAnnot',
	targetFile: '快速笔记/Annotation.md'
}

export default class XFDFImporterPlugin extends Plugin {
	settings: XFDFImporterSettings;

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

	// 3. 【核心移植】生成 pxce 链接 (使用 comment ID)
	generatePxceLink(xfdfFileName: string, pageNum: number, commentId: string): string {
		const xfdfVaultPath = `${this.settings.xfdfFolder}/${xfdfFileName}`;
		
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("Error: Cannot generate link, vault is not a local file system.");
			return "";
		}
		const vaultPath = adapter.getBasePath();
		const xfdfAbsolutePath = `${vaultPath}\\${xfdfVaultPath.replace(/\//g, '\\')}`;
		const encodedXfdfPath = this.convertToFullyEncodedUnixPathXFDF(xfdfAbsolutePath);

		// 【关键】使用 comment ID 直接定位，不再需要坐标
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
		const xfdfFiles = xfdfFolderAbstractFile.children
			.filter((f): f is TFile => f instanceof TFile)
			.map(f => f.name)
			.filter(name => name.endsWith('.xfdf'));

		for (const file of xfdfFiles) {
			const xfdfFile = this.app.vault.getAbstractFileByPath(`${xfdfFolder}/${file}`) as TFile;
			if (!xfdfFile) continue;
			const xfdfString = await this.app.vault.read(xfdfFile);
			const docTitle = file.replace(/\.xfdf$/, '');

			const snapshotLines = this.parseXFDFToSnapshot(xfdfString);
			if (snapshotLines.length === 0) {
				continue;
			}

			// 新增：将快照行转换为注释对象
			const annotations = snapshotLines.map(line => {
				const [type, contents, rect, color, subject, name, page] = line.split('|');
				const uniqueId = name || `${docTitle}-${Date.now()}`;
				const pageNum = (page ? parseInt(page, 10) : 1); // 使用上面解构出来的 page 变量，已经加1了

				
				// 生成 pxce 链接
				const pxceLink = this.generatePxceLink(file, pageNum, uniqueId);

				// 生成 Obsidian 链接
				const obsidianLink = `${type}: ${contents || '查看注释'} [${docTitle}：第${pageNum}页](${pxceLink})`;

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

			// 存储到 allNewAnnotations
			if (!allNewAnnotations[docTitle]) {
				allNewAnnotations[docTitle] = [];
			}
			allNewAnnotations[docTitle].push(...annotations);
		}


		// 3. 【核心新逻辑】重建文件内容，智能保留用户修改
		const finalContentLines: string[] = [];
		let currentLineIndex = 0;
		const processedTitles = new Set<string>();

		// 辅助函数：从注释行中提取 uniqueId
		const getIdFromLine = (line: string) => {
			const match = line.match(/<!--\s*(.+?)\s*-->/);
			return match ? match[1] : null;
		};

		while (currentLineIndex < originalLines.length) {
			const line = originalLines[currentLineIndex];
			const trimmedLine = line.trim();

			// 检查是否是一个标题行
			const titleMatch = trimmedLine.match(/^(#+)\s+(.*)/);
			if (titleMatch) {
				const titleText = titleMatch[2];
				processedTitles.add(titleText);

				// 将标题行加入最终内容
				finalContentLines.push(line);
				currentLineIndex++;

				// 获取这个标题对应的新注释
				const newAnnotationsForTitle = allNewAnnotations[titleText] || [];
				const newIds = new Set(newAnnotationsForTitle.map(a => a.uniqueId));

				// 收集这个标题下的所有旧注释，并智能处理
				while (currentLineIndex < originalLines.length) {
					const peekLine = originalLines[currentLineIndex];
					const nextTitleMatch = peekLine.trim().match(/^(#+)\s+(.*)/);
					if (nextTitleMatch && nextTitleMatch[1].length <= titleMatch[1].length) {
						break; // 遇到同级或更高级标题，停止
					}

					const oldId = getIdFromLine(peekLine);
					
					if (oldId && newIds.has(oldId)) {
						const newAnnotation = newAnnotationsForTitle.find(a => a.uniqueId === oldId);
						if (newAnnotation) {
							// 1. 提取新旧两行中的“核心链接部分”
							// 使用正则表达式匹配 `- [任何内容](任何链接) <!-- ID -->` 的结构
							const coreLinkRegex = /^- \[.*?\]\(.*?\) <!--\s*.+?\s*-->\s*(\[tag::.*?\])?$/;
							
							const oldCoreLink = peekLine.match(coreLinkRegex)?.[0] || "";
							const newCoreLink = `- ${newAnnotation.obsidianLink} <!--${newAnnotation.uniqueId} -->[tag:: ]`;

							// 2. 比较核心部分是否一致
							if (oldCoreLink === newCoreLink) {
								// 核心链接完全一样，说明用户没改过链接本身，直接保留整行（包括用户添加的标签等）
								finalContentLines.push(peekLine);
							} else {
								// 核心链接不一样了（可能是页码变了，或者内容变了），用新的标准链接替换
								finalContentLines.push(newCoreLink);
							}
						}
						currentLineIndex++;
					} else {
						// 【修复】这不是一个已知的注释行，也不是新标题，所以是用户自定义内容，直接保留
						finalContentLines.push(peekLine);
						currentLineIndex++; // 保留了用户行，索引前进
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
						finalContentLines.push(`- ${newAnnot.obsidianLink} <!-- ${newAnnot.uniqueId} -->[tag:: ]`);
					}
				}


			} else {
				// 如果不是标题，直接将该行加入最终内容
				finalContentLines.push(line);
				currentLineIndex++;
			}
		}

		// 4. 处理所有没有找到对应标题的“孤儿”注释，并为它们创建新标题
		const orphanTitles = Object.keys(allNewAnnotations).filter(title => !processedTitles.has(title));

		if (orphanTitles.length > 0) {
			finalContentLines.push('\n\n---\n');
			for (const docTitle of orphanTitles) {
				finalContentLines.push(`\n# ${docTitle}\n`);
				const newAnnotationLines = allNewAnnotations[docTitle].map(annot => 
					`- ${annot.obsidianLink} <!-- ${annot.uniqueId} -->[tag:: ]`
				);
				finalContentLines.push(...newAnnotationLines);
			}
		}

		// 5. 写入文件
		await this.app.vault.modify(targetFileObj, finalContentLines.join('\n').trim());
		new Notice('XFDF annotations imported successfully!');
		
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
	}
}


