//go:build wasip2

// 宿主能力 Go 惯用包装——core.wit 九个内核机制接口（Rust 侧 `WasmHost` /
// `HostApi` 的对等物，issue #21 User Story 3）。能力域接口（ws / peer / pty /
// mdns / notify / …）首期经 gen 包直用（`gen/wasmnest/plugin/host-*`），惯用
// 包装随消费面出现再补（http 已落，见 host_http_wasip2.go）——不为没有调用者
// 的面预制 API。
//
// 返回形状约定（WIT result<T, string> 的 Go 落地）：
//   - result<option<string>, string> → (value string, ok bool, err error)
//     （ok=false 且 err=nil = 键不存在 / 文件不存在等合法空态）
//   - result<_, string> → error
//   - result<string, string> / result<u32, string> / result<bool, string> → (value, error)
//
// 注意：每个 gen 包的 Shape 类型（如 OptionStringShape）是独立命名类型，
// 解包经对 Shape 泛型的内部辅助函数统一。
package sdk

import (
	"errors"

	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-bus"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-config"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-events"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-fs"
	hostlog "github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-log"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-metrics"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-platform"
	hostplugindatabase "github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-plugin-database"
	"github.com/7zai/wasmnest-plugin-sdk-go/gen/wasmnest/plugin/host-storage"
	"go.bytecodealliance.org/cm"
)

// ==================== 内部解包辅助 ====================

// optString 解包 result<option<string>, string>：err 非 nil = 宿主侧 Err；
// ok=false 且 err=nil = 合法空态。
func optString[Shape any](res cm.Result[Shape, cm.Option[string], string]) (value string, ok bool, err error) {
	if res.IsErr() {
		return "", false, errOf(res)
	}
	opt := res.OK()
	if opt == nil || opt.None() {
		return "", false, nil
	}
	if some := opt.Some(); some != nil {
		return *some, true, nil
	}
	return "", false, nil
}

// errOf 取 result 错误串（本 SDK 面内 Err 恒为 string）。
func errOf[Shape, OK any](res cm.Result[Shape, OK, string]) error {
	if e := res.Err(); e != nil {
		return errors.New(*e)
	}
	return nil
}

// unitErr 解包 result<_, string> 为 error。
func unitErr(res cm.Result[string, struct{}, string]) error {
	if res.IsErr() {
		return errOf(res)
	}
	return nil
}

// ==================== host-log（日志与插件状态上报） ====================

// HostLogInfo / HostLogDebug / HostLogWarn / HostLogError 写宿主日志。
// 纪律（AGENTS §8 日志红线）：guest 自报的可处理错误用 Warn 不用 Error。
func HostLogInfo(message string)  { hostlog.Info(message) }
func HostLogDebug(message string) { hostlog.Debug(message) }
func HostLogWarn(message string)  { hostlog.Warn(message) }
func HostLogError(message string) { hostlog.Error(message) }

// HostMarkPluginError 上报插件错误态（宿主计入插件健康面）。
func HostMarkPluginError(err string) { hostlog.MarkPluginError(err) }

// ==================== host-config（宿主配置读取） ====================

// HostConfigGet 读宿主配置键（key 为 ConfigKey::as_str 串，如 home_dir）。
func HostConfigGet(key string) (string, bool, error) {
	return optString(hostconfig.Get(key))
}

// ==================== host-storage（插件 KV 存储） ====================

// HostStorageGet 读插件 KV；ok=false = 键不存在。
func HostStorageGet(key string) (string, bool, error) {
	return optString(hoststorage.Get(key))
}

// HostStorageSet 写插件 KV（覆盖写）。
func HostStorageSet(key, value string) error { return unitErr(hoststorage.Set(key, value)) }

// HostStorageDelete 删插件 KV（键不存在也视为成功，幂等）。
func HostStorageDelete(key string) error { return unitErr(hoststorage.Delete(key)) }

// ==================== host-events（事件发射） ====================

// HostEventEmit 发射插件事件（无返回值；载荷非法等失败由宿主侧记录）。
func HostEventEmit(eventName, payloadJSON string) { hostevents.Emit(eventName, payloadJSON) }

// ==================== host-bus（消息总线） ====================

// HostBusPublish 发布 JSON 载荷总线消息（topic 命名空间纪律见 core.wit
// host-bus 注释：私有 `<plugin-id>::<name>` / 公开 `task:*` 等）。
func HostBusPublish(topic, payloadJSON string) error {
	return unitErr(hostbus.Publish(topic, payloadJSON))
}

// HostBusPublishBinary 发布二进制载荷（零 JSON 编解码，可传非 UTF-8 与大载荷；
// 订阅方须以 HostBusSubscribeBinary 声明偏好）。
func HostBusPublishBinary(topic string, payload []byte) error {
	return unitErr(hostbus.PublishBinary(topic, cm.ToList(payload)))
}

// HostBusSubscribe 订阅 topic（JSON 格式）。
func HostBusSubscribe(topic string) error { return unitErr(hostbus.Subscribe(topic)) }

// HostBusSubscribeBinary 以二进制格式偏好订阅（只收 publish-binary 投递）。
func HostBusSubscribeBinary(topic string) error { return unitErr(hostbus.SubscribeBinary(topic)) }

// HostBusUnsubscribe 退订。
func HostBusUnsubscribe(topic string) error { return unitErr(hostbus.Unsubscribe(topic)) }

// ==================== host-plugin-database（插件独立数据库） ====================

// HostDBExecute 执行 SQL，返回受影响行数。
func HostDBExecute(sql string) (uint32, error) {
	res := hostplugindatabase.Execute(sql)
	if res.IsErr() {
		return 0, errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return 0, nil
}

// HostDBQuery 查询 SQL，返回结果 JSON（ok=false = 无结果行）。
func HostDBQuery(sql string) (string, bool, error) {
	return optString(hostplugindatabase.Query(sql))
}

// HostDBExecuteParams 参数化执行（paramsJSON 形如 `[?, ?, …]` 位置参数数组）。
func HostDBExecuteParams(sql, paramsJSON string) (uint32, error) {
	res := hostplugindatabase.ExecuteParams(sql, paramsJSON)
	if res.IsErr() {
		return 0, errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return 0, nil
}

// HostDBQueryParams 参数化查询。
func HostDBQueryParams(sql, paramsJSON string) (string, bool, error) {
	return optString(hostplugindatabase.QueryParams(sql, paramsJSON))
}

// HostDBExecuteBatch 事务内顺序执行多语句（sqlsJSON 为 SQL 数组），返回合计行数。
func HostDBExecuteBatch(sqlsJSON string) (uint32, error) {
	res := hostplugindatabase.ExecuteBatch(sqlsJSON)
	if res.IsErr() {
		return 0, errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return 0, nil
}

// ==================== host-metrics（运行监控快照） ====================

// HostMetricsSnapshot 只读运行指标快照 JSON（权限 metrics:read；快照源未装配
// 时显性报错，不返回空对象冒充）。
func HostMetricsSnapshot() (string, error) {
	res := hostmetrics.Snapshot()
	if res.IsErr() {
		return "", errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return "", nil
}

// ==================== host-fs（文件系统交集 6 原语） ====================

// HostFSRead 读文本文件（ok=false = 文件不存在；路径未授权等显性报错）。
func HostFSRead(path string) (string, bool, error) { return optString(hostfs.Read(path)) }

// HostFSWrite 写文本文件。
func HostFSWrite(path, data string) error { return unitErr(hostfs.Write(path, data)) }

// HostFSCopy 复制文件。
func HostFSCopy(src, dst string) error { return unitErr(hostfs.Copy(src, dst)) }

// HostFSDelete 删除文件。
func HostFSDelete(path string) error { return unitErr(hostfs.Delete(path)) }

// HostFSExists 探测存在性。
func HostFSExists(path string) (bool, error) {
	res := hostfs.Exists(path)
	if res.IsErr() {
		return false, errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return false, nil
}

// HostFSRequestAuth 批量请求目录授权（pathsJSON 为绝对路径数组；返回是否
// 全部同意——用户拒绝时显性 false，不静默降级为空授权）。
func HostFSRequestAuth(pathsJSON string) (bool, error) {
	res := hostfs.RequestAuth(pathsJSON)
	if res.IsErr() {
		return false, errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return false, nil
}

// ==================== host-platform（平台能力交集） ====================

// HostPickFiles 系统多文件选择器 → string[] JSON（用户取消为空数组；
// 权限 fs:pick + 选择后授权校验，见 core.wit）。
func HostPickFiles() (string, error) { return stringResult(hostplatform.PickFiles()) }

// HostPickFolders 系统文件夹选择器（多选）→ string[] JSON。
func HostPickFolders() (string, error) { return stringResult(hostplatform.PickFolders()) }

// HostPlatformName 宿主平台标识（desktop / mobile；无权限门）。
func HostPlatformName() string { return hostplatform.Platform() }

// stringResult 解包 result<string, string>。
func stringResult(res cm.Result[string, string, string]) (string, error) {
	if res.IsErr() {
		return "", errOf(res)
	}
	if v := res.OK(); v != nil {
		return *v, nil
	}
	return "", nil
}
