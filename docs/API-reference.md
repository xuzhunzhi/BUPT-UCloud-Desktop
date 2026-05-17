# BUPT UCloud 教学平台 API 参考

## 基本信息

- **前端 SPA 地址**: `https://ucloud.bupt.edu.cn/uclass/index.html`（门户） + `course.html`（课程内部）
- **API Base URL**: `https://apiucloud.bupt.edu.cn`
- **认证方式**: CAS SSO → JWT（`Blade-Auth` header 或 cookie）
- **响应信封**: `{code: 200, success: true, data: ...}`（BladeX 框架）
- **分页格式**: `{records: [...], total: N, size: N, current: N, pages: N}`

---

## 一、认证

### POST /ykt-basics/oauth/token

获取 JWT access_token。

**响应**:
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 7199,
  "scope": "all",
  "tenant_id": "000000",
  "user_id": "1823312419853684774",
  "user_name": "2024210913",
  "real_name": "张三",
  "account": "2024210913",
  "currentRole": "JS005",
  "currentDomain": "1325774332638531585",
  "currentTerm": "-1",
  "client_id": "portal",
  "license": "powered by bladex"
}
```

**关键字段**:
- `user_id` — 用于后续所有 API 调用
- `currentRole` — 角色代码（JS005 = 学生角色）
- `access_token` — JWT，过期约2小时
- `currentDomain` — 域 ID（本科/研究生等）

---

## 二、用户信息

### GET /ykt-basics/info

当前登录用户详细信息。

**响应 data**:
```json
{
  "id": "...",
  "account": "2024210913",
  "name": "...",
  "realName": "...",
  "avatar": "https://fileucloud.bupt.edu.cn/...",
  "email": "",
  "phone": "",
  "sex": 1,
  "roleId": "...",
  "deptId": "...",
  "professional": "...",
  "deptName": "计算机学院"
}
```

### GET /ykt-basics/userroledomaindept/listByUserId

用户角色、域、部门关联信息。

**响应 data** (数组):
```json
[{
  "id": "...",
  "roleId": "1318863781576577025",
  "roleName": "本科学生",
  "roleAliase": "JS005",
  "domainId": "1325774332638531585",
  "domainName": "本科",
  "deptId": "...",
  "deptName": "计算机学院",
  "managementDeptId": "...",
  "termId": "..."
}]
```

### GET /ykt-basics/dept/tree?isOpenClass=1

部门/院系树（33个节点）。

**响应 data** (数组):
```json
[{
  "id": "...",
  "parentId": "0",
  "title": "计算机学院",
  "key": "...",
  "value": "...",
  "hasChildren": true
}]
```

---

## 三、学期

### GET /ykt-site/base-term/current

当前学期信息。

**响应 data**:
```json
{
  "id": "1693148401899671554",
  "termName": "2026春季",
  "termCode": "202502",
  "originalTermCode": "2025-2026-2",
  "termType": 1,
  "termStartTime": "2026-02-23",
  "termEndTime": "2026-07-05",
  "isCurrent": 1
}
```

### GET /ykt-site/base-term/list?size=9999

全部学期列表（分页，~15条记录）。

---

## 四、课程数据

### GET /ykt-site/site/list/student/current

当前学期全部在修课程。

**参数**:
| 参数 | 说明 | 示例 |
|------|------|------|
| `userId` | 用户 ID | `1823312419853684774` |
| `siteRoleCode` | 角色代码 | `2`（学生） |
| `size` | 每页条数 | `999999`（取全部） |
| `current` | 页码 | `1` |

**响应 data.records[]**:
```json
{
  "id": "2018158400926445571",
  "siteName": "数学分析(下)",
  "termId": "1693148401899671554",
  "departmentId": "...",
  "baseCourseId": "...",
  "domainId": "...",
  "domainName": "本科",
  "courseCode": "3412110063",
  "courseType": "公共课",
  "kcsx": "必修",
  "kclb": "理论课（不含实践）",
  "department": "数学科学学院",
  "teacherId": "...",
  "teachers": [{
    "id": "...",
    "name": "江彦",
    "realName": "江彦",
    "professional": "副教授",
    "avatar": "https://fileucloud.bupt.edu.cn/..."
  }],
  "picUrl": "https://fileucloud.bupt.edu.cn/...",
  "cloneCode": "IIOwUa",
  "createTime": "2026-02-02T11:03:48"
}
```

### GET /ykt-site/site/list/visit/current

最近访问的课程。

**参数**: `size`, `current`, `userId`, `siteRoleCode=2`

### GET /ykt-site/site/list/student/history

历史学期课程。

**参数**: `userId`, `departmentId`, `termId`, `siteName`, `size`, `current`

---

## 五、待办（核心接口）

### GET /ykt-site/site/student/undone

学生全部课程待办事项（作业/测验/问卷等），**不分页**。

**参数**:
| 参数 | 说明 |
|------|------|
| `userId` | 用户 ID |

**响应 data**:
```json
{
  "siteNum": 14,
  "undoneNum": 36,
  "undoneList": [{
    "siteId": -1,
    "siteName": "",
    "activityName": "第十六次作业 数分",
    "activityId": "...",
    "type": 3,
    "endTime": "2026-05-05 23:59:59",
    "assignmentType": -1,
    "evaluationStatus": 0,
    "isOpenEvaluation": 0
  }]
}
```

**字段说明**:
| 字段 | 含义 |
|------|------|
| `siteId` | 课程站点 ID（-1 表示跨课程） |
| `siteName` | 课程名（当前版本可能为空） |
| `activityName` | 活动/作业名称 |
| `activityId` | 活动唯一 ID |
| `type` | 类型（3=作业，其他待确认） |
| `endTime` | 截止时间 `YYYY-MM-DD HH:mm:ss` |
| `assignmentType` | 作业类型（-1=未分类） |
| `evaluationStatus` | 评阅状态（0=未评） |
| `isOpenEvaluation` | 是否开启互评 |

---

## 六、菜单/导航

### GET /ykt-basics/menu/role-grant?roleId=<roleId>

获取角色的菜单/导航结构（56项），可用于了解平台全部页面路由。

**菜单树结构**:
```
教学云平台菜单
├── 个人中心
│   ├── 主页 → /#/student/homePage
│   ├── 我的课堂 → /#/student/myCourse
│   ├── 我的问卷 → /#/student/Survey
│   └── 我的笔记 → /#/student/myNotes
└── 课程中心 → course.html#/...
    ├── 课程基本信息
    ├── 主页 → /student/courseHomePage
    ├── 作业 → /student/studentAssignmentListPage
    ├── 测验 → /testing
    ├── 讨论 → /student/forum
    ├── 问卷 → /student/siteSurvey
    ├── 学情 → /teacher/studySituation
    ├── 成绩 → /teacher/achievement
    ├── 成员 → /student/siteMember
    ├── 公告 → /student/notice
    ├── 反馈 → /student/feedback
    └── 反思 → /teacher/examination
```

---

## 七、门户首页

### GET /blade-portal/home-page-info/getShufflingWebList

首页轮播图/Banner（5条）。

**响应 data[]**:
```json
[{"id": "...", "resourceUrl": "https://...", "resourceName": "..."}]
```

### GET /blade-portal/service-center/get4HotService?size=4&roleId=<roleId>

热门服务入口（4条）。

**响应 data[]**:
```json
[{"id": "...", "serviceLink": "https://...", "serviceName": "..."}]
```

### GET /blade-portal/news/newest

最新资讯/新闻。

**参数**: `type`（1=新闻, 2=通知）, `size`

**响应 data[]**:
```json
[{
  "id": "...",
  "title": "...",
  "author": "...",
  "wbcontent": "<html>...</html>",
  "date": "2026-05-05",
  "treeid": "...",
  "wbshowtimes": 0
}]
```

### GET /ykt-site/excellent/pageFront?current=1&size=8

精品课程/推荐内容（分页）。

---

## 八、通知

### POST /ykt-basics/api/inform/news/unReadNum

未读通知数量。

**参数**: `newsCopyPersonId` (= userId)

### GET /ykt-basics/api/inform/news/page

通知分页列表（需确认）。

**参数**: `size`, `current`

---

## 九、问卷（Survey）

仅在导航到 `#/student/Survey` 时触发。

### GET /ykt-activity/survey/page/todo

待完成问卷。

**参数**: `level=3`, `userId`, `current`, `size`

### GET /ykt-activity/survey/page/done

已完成问卷。

**参数**: `userId`, `current`

---

## 十、未验证接口（尝试过但未成功）

以下端点直接 fetch 返回 404，可能需要在 course.html 上下文中由 SPA 触发，或需要特定参数/header：

| 接口 | 说明 |
|------|------|
| `/ykt-site/site/detail?siteId=` | 课程详情 |
| `/ykt-site/site/info?siteId=` | 课程信息 |
| `/ykt-activity/activity/page?siteId=` | 活动列表 |
| `/ykt-activity/task/page?siteId=` | 任务列表 |
| `/ykt-site/homework/list/student?siteId=` | 单课程作业列表 |
| `/ykt-site/achievement/student?siteId=` | 成绩 |

---

## 十一、抓取策略

当前 `homework_fetcher.py` 的抓取流程：

1. 导航到 `uclass/index.html#/student/homePage`
2. 检测 SPA 是否重定向到首页，如有则重新导航
3. 等待 API 响应通过 `page.on("response")` 捕获
4. 从以下来源提取作业项：
   - **DOM 选择器**（多套启发式规则）
   - **API 响应 JSON**（递归搜索 `title`/`activityName`/`endTime` 等字段）
   - **`/site/student/undone` API**（最可靠来源）
5. 去重 + 垃圾过滤（菜单项、新闻、统计数字等）
6. 写入 `homework_cache.json`

### 垃圾过滤规则

- 纯数字标题（如 "14"）
- 无中文且 <4 字符的标题
- 导航菜单项（首页、个人中心、我的课堂等）
- `-老师`/`-学生` 后缀且无截止时间的条目
- 新闻/通知标题（含"通报"、"公示"且无课业关键词）
