// 在 Windows release 构建中阻止额外的控制台窗口出现，切勿删除！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kotori_pet_lib::run()
}
